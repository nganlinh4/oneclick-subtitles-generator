use std::ptr::NonNull;
use std::sync::Arc;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{
    NSData, NSDictionary, NSError, NSObject, NSObjectProtocol, NSRunLoop, NSRunLoopCommonModes,
    NSString, NSTimer,
};
use objc2_web_kit::{
    WKContentWorld, WKFrameInfo, WKPDFConfiguration, WKScriptMessage, WKScriptMessageHandler,
    WKSnapshotConfiguration, WKUIDelegate, WKUserContentController, WKWebView,
};
use serde_json::Value;
use tauri::{Manager, Runtime, WebviewWindow};
use tokio::sync::oneshot;

use crate::eval_channel::EvalResultRegistry;
use crate::platform::alert_state::{AlertState, AlertStateManager, AlertType, PendingAlert};
use crate::platform::{wrap_script_for_frame_context, FrameId, PlatformExecutor, PrintOptions};
use crate::server::response::WebDriverErrorResponse;
use crate::webdriver::Timeouts;

/// Key for associating the UI delegate with the webview
static DELEGATE_KEY: u8 = 0;

/// macOS `WebView` executor using `WKWebView` native APIs
#[derive(Clone)]
pub struct MacOSExecutor<R: Runtime> {
    window: WebviewWindow<R>,
    timeouts: Timeouts,
    frame_context: Vec<FrameId>,
}

impl<R: Runtime> MacOSExecutor<R> {
    pub fn new(window: WebviewWindow<R>, timeouts: Timeouts, frame_context: Vec<FrameId>) -> Self {
        Self {
            window,
            timeouts,
            frame_context,
        }
    }

    /// Dispatch one `callAsyncJavaScript` attempt of a DirectEval wrapper. The returned receiver fires
    /// when macOS 26.4's WebKit reclaims the completion with no value — the signal `execute_direct_eval`
    /// uses to re-dispatch. When the completion *does* carry a value, it is delivered to `registry` as a
    /// fallback for a lost message-handler post (first-write-wins keeps the post authoritative).
    fn dispatch_eval_attempt(
        &self,
        wrapper: &str,
        id: &str,
        registry: &Arc<EvalResultRegistry>,
        attempt: usize,
    ) -> Result<oneshot::Receiver<()>, String> {
        let (fail_tx, fail_rx) = oneshot::channel::<()>();
        let wrapper = wrapper.to_owned();
        let id = id.to_owned();
        let registry = registry.clone();
        // `RcBlock` is `Fn` but `Sender::send` consumes self, so guard the one-shot send (WebKit calls
        // the completion once; this just makes a double-call harmless). Same pattern as `evaluate_js`.
        let fail_tx = Arc::new(std::sync::Mutex::new(Some(fail_tx)));

        self.window
            .with_webview(move |webview| unsafe {
                let wk_webview: &WKWebView = &*webview.inner().cast();
                let ns_script = NSString::from_str(&wrapper);
                let mtm = MainThreadMarker::new_unchecked();
                let empty_dict: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
                let content_world = WKContentWorld::pageWorld(mtm);

                let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                    if !error.is_null() {
                        tracing::debug!(
                            "DirectEval completion reclaimed (attempt {attempt}): {}",
                            describe_ns_error(&*error)
                        );
                        if let Ok(mut guard) = fail_tx.lock() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(());
                            }
                        }
                        return;
                    }
                    if !result.is_null() {
                        registry.complete(&id, ns_object_to_json(&*result));
                    }
                });

                wk_webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                    &ns_script,
                    Some(&empty_dict),
                    None,
                    &content_world,
                    Some(&block),
                );
            })
            .map_err(|e| e.to_string())?;

        Ok(fail_rx)
    }
}

/// Register `WKWebView` handlers at webview creation time.
/// This is called from the plugin's `on_webview_ready` hook to ensure
/// the UI delegate is registered before any navigation completes.
pub fn register_webview_handlers<R: Runtime>(webview: &tauri::Webview<R>) {
    use objc2::ffi::{objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC};

    // Get per-window alert state from the manager
    let manager = webview.app_handle().state::<AlertStateManager>();
    let alert_state = manager.get_or_create(webview.label());
    // Cloned Arc so the (non-generic) objc2 message handler can hold it for the webview's lifetime.
    let eval_registry = webview
        .app_handle()
        .state::<Arc<EvalResultRegistry>>()
        .inner()
        .clone();

    let _ = webview.with_webview(move |webview| unsafe {
        let wk_webview: &WKWebView = &*webview.inner().cast();

        let delegate = WebDriverUIDelegate::new(alert_state);
        let delegate_protocol: Retained<ProtocolObject<dyn WKUIDelegate>> =
            ProtocolObject::from_retained(delegate);

        let _: () = msg_send![wk_webview, setUIDelegate: &*delegate_protocol];

        // Associate delegate with webview - released when webview is deallocated
        objc_setAssociatedObject(
            std::ptr::from_ref::<WKWebView>(wk_webview)
                .cast_mut()
                .cast(),
            std::ptr::addr_of!(DELEGATE_KEY).cast(),
            Retained::into_raw(delegate_protocol).cast(),
            OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );

        // The DirectEval result channel (see execute_direct_eval). WKUserContentController retains the
        // handler for the webview's lifetime, so — unlike the UI delegate — it needs no associated object.
        let eval_handler = EvalMessageHandler::new(eval_registry);
        let eval_proto: Retained<ProtocolObject<dyn WKScriptMessageHandler>> =
            ProtocolObject::from_retained(eval_handler);
        wk_webview
            .configuration()
            .userContentController()
            .addScriptMessageHandler_name(&eval_proto, &NSString::from_str("wdioEvalResult"));

        start_runloop_pump();

        tracing::debug!("Registered UI delegate + eval message handler for webview");
    });
}

/// Keep the app's main run loop waking on a headless/off-screen runner.
///
/// With no display, the app parks in `-[NSApplication run]` waiting for events, so WebKit doesn't
/// promptly service WebContent's URL-scheme resource requests (page-load subresources) or eval
/// dispatches — a DirectEval can then stall for tens of seconds and time out. A no-op timer in the
/// run loop's common modes forces it to wake, draining that pending work each tick; the interval only
/// bounds worst-case servicing latency (well under the command timeout). Harmless with a real display
/// (the loop already pumps continuously). This plugin ships only in WebDriver-automation builds.
///
/// `Once`-guarded, so it is safe to schedule from both plugin `setup` (earliest — covers cold-start
/// and deeplink navigation before the first webview is ready) and `on_webview_ready` (fallback).
/// https://github.com/webdriverio/desktop-mobile/issues/540
///
/// # Safety
/// Must be called on the main thread (schedules on the main run loop).
pub unsafe fn start_runloop_pump() {
    use std::sync::Once;
    static PUMP: Once = Once::new();
    PUMP.call_once(|| {
        let block = RcBlock::new(|_timer: NonNull<NSTimer>| {});
        let timer = NSTimer::timerWithTimeInterval_repeats_block(0.05, true, &block);
        NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
        tracing::debug!("Started macOS main run-loop pump for headless WebKit scheduling");
    });
}

#[async_trait]
impl<R: Runtime + 'static> PlatformExecutor<R> for MacOSExecutor<R> {
    // =========================================================================
    // Window Access
    // =========================================================================

    fn window(&self) -> &WebviewWindow<R> {
        &self.window
    }

    fn script_timeout_ms(&self) -> u64 {
        self.timeouts.script_ms
    }

    // =========================================================================
    // Core JavaScript Execution
    // =========================================================================

    async fn evaluate_js(&self, script: &str) -> Result<Value, WebDriverErrorResponse> {
        let (tx, rx) = oneshot::channel();
        let script_owned = wrap_script_for_frame_context(script, &self.frame_context);

        let result = self.window.with_webview(move |webview| unsafe {
            let wk_webview: &WKWebView = &*webview.inner().cast();
            let ns_script = NSString::from_str(&script_owned);

            let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
            let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                let response = if !error.is_null() {
                    let error_ref = &*error;
                    Err(describe_ns_error(error_ref))
                } else if result.is_null() {
                    Ok(Value::Null)
                } else {
                    let obj = &*result;
                    Ok(ns_object_to_json(obj))
                };

                if let Ok(mut guard) = tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(response);
                    }
                }
            });

            // Use evaluateJavaScript for script execution
            wk_webview.evaluateJavaScript_completionHandler(&ns_script, Some(&block));
        });

        if let Err(e) = result {
            return Err(WebDriverErrorResponse::javascript_error(
                &e.to_string(),
                None,
            ));
        }

        let timeout = std::time::Duration::from_millis(self.timeouts.script_ms);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(serde_json::json!({
                "success": true,
                "value": value
            })),
            Ok(Ok(Err(error))) => Err(WebDriverErrorResponse::javascript_error(&error, None)),
            Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error("Channel closed")),
            Err(_) => Err(WebDriverErrorResponse::script_timeout()),
        }
    }

    // =========================================================================
    // Async Script Execution (using callAsyncJavaScript)
    // =========================================================================

    async fn execute_async_script(
        &self,
        script: &str,
        args: &[Value],
    ) -> Result<Value, WebDriverErrorResponse> {
        let args_json = serde_json::to_string(args)
            .map_err(|e| WebDriverErrorResponse::invalid_argument(&e.to_string()))?;

        // Build wrapper that includes argument deserialization.
        // callAsyncJavaScript treats the body as function statements, so `return` is required —
        // without it the function returns undefined immediately and the Promise is discarded.
        let wrapper = format!(
            r"return new Promise((resolve, reject) => {{
                var ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
                function deserializeArg(arg) {{
                    if (arg === null || arg === undefined) return arg;
                    if (Array.isArray(arg)) return arg.map(deserializeArg);
                    if (typeof arg === 'object') {{
                        if (arg[ELEMENT_KEY]) {{
                            var el = window['__wd_el_' + arg[ELEMENT_KEY].replace(/-/g, '')];
                            if (!el) throw new Error('stale element reference');
                            return el;
                        }}
                        var result = {{}};
                        for (var key in arg) {{
                            if (arg.hasOwnProperty(key)) result[key] = deserializeArg(arg[key]);
                        }}
                        return result;
                    }}
                    return arg;
                }}
                var __done = function(result, error) {{
                    if (error) {{
                        reject(new Error(typeof error === 'string' ? error : String(error)));
                    }} else {{
                        resolve(result);
                    }}
                }};
                var __args = {args_json}.map(deserializeArg);
                __args.push(__done);
                try {{
                    (function() {{ {script} }}).apply(null, __args);
                }} catch (e) {{
                    reject(e);
                }}
            }})"
        );

        let (tx, rx) = oneshot::channel();

        let result = self.window.with_webview(move |webview| unsafe {
            let wk_webview: &WKWebView = &*webview.inner().cast();
            let ns_script = NSString::from_str(&wrapper);
            let mtm = MainThreadMarker::new_unchecked();

            // Empty dictionary for arguments (we pass args via JSON in the script)
            let empty_dict: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();

            // Get the page content world
            let content_world = WKContentWorld::pageWorld(mtm);

            let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
            let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                let response = if !error.is_null() {
                    let error_ref = &*error;
                    Err(describe_ns_error(error_ref))
                } else if result.is_null() {
                    Ok(Value::Null)
                } else {
                    let obj = &*result;
                    Ok(ns_object_to_json(obj))
                };

                if let Ok(mut guard) = tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(response);
                    }
                }
            });

            wk_webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &ns_script,
                Some(&empty_dict),
                None,
                &content_world,
                Some(&block),
            );
        });

        if let Err(e) = result {
            return Err(WebDriverErrorResponse::javascript_error(
                &e.to_string(),
                None,
            ));
        }

        let timeout = std::time::Duration::from_millis(self.timeouts.script_ms);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(WebDriverErrorResponse::javascript_error(&error, None)),
            Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error("Channel closed")),
            Err(_) => Err(WebDriverErrorResponse::script_timeout()),
        }
    }

    /// DirectEval (`/wdio/eval`) with out-of-band result delivery + reclaim recovery.
    ///
    /// Each attempt is dispatched by `dispatch_eval_attempt` via `callAsyncJavaScript`, which keeps the
    /// run loop pumping — on a headless runner the app's own `core.invoke` IPC response only completes
    /// while WebKit holds a run-loop activity. The result is delivered primarily out-of-band: the
    /// wrapper posts `{ id, result }` to the `wdioEvalResult` `WKScriptMessageHandler`, which completes
    /// the `oneshot` awaited here. macOS 26.4's WebKit intermittently reclaims the `callAsyncJavaScript`
    /// completion ("Completion handler for function call is no longer reachable"); usually the post
    /// still lands, but sometimes the script never posts and this would otherwise dead-wait to the
    /// script timeout (#540 residual). Two guards recover it without changing the happy path:
    ///   1. **Fallback delivery** — when the completion *does* fire with a value, `dispatch_eval_attempt`
    ///      hands it to the same registry (first-write-wins keeps the post authoritative), so a lost
    ///      post resolves instead of dead-waiting.
    ///   2. **Bounded re-dispatch** — when the completion is reclaimed with *no* value and no post lands
    ///      within `RECLAIM_GRACE`, re-run the script (up to `MAX_ATTEMPTS`). The grace lets a racing
    ///      post settle first; a genuine re-dispatch *re-executes* the script, so a non-idempotent eval
    ///      could double-apply — acceptable for the read-style evals `execute` runs in practice.
    /// The whole sequence is bounded by `deadline`. Mirrors the Windows native-handler path
    /// (`AsyncScriptState`). https://github.com/webdriverio/desktop-mobile/issues/540
    ///
    /// `wrapScriptForDirectEval` produces a callback-style script (`arguments[last]` is its
    /// done-callback); `__report` forwards the result to the message handler then `resolve`s so the
    /// `callAsyncJavaScript` promise settles.
    async fn execute_direct_eval(&self, script: &str) -> Result<Value, WebDriverErrorResponse> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = format!("wdio_de_{}", COUNTER.fetch_add(1, Ordering::Relaxed));

        // Register the waiter before dispatching, so a fast report can't arrive before we're listening.
        let registry = self
            .window
            .state::<Arc<EvalResultRegistry>>()
            .inner()
            .clone();
        let mut rx = registry.register(id.clone());

        // id is alphanumeric + '_', so it needs no escaping in the JS string literal below.
        let wrapper = format!(
            r#"return new Promise((resolve) => {{
  var __report = function (r) {{
    try {{ window.webkit.messageHandlers.wdioEvalResult.postMessage({{ id: "{id}", result: r }}); }} catch (e) {{}}
    resolve(r);
  }};
  (function () {{ {script} }}).apply(null, [__report]);
}});"#
        );

        const MAX_ATTEMPTS: usize = 3;
        // After a reclaim, wait this long for a racing message-handler post before re-running.
        const RECLAIM_GRACE: std::time::Duration = std::time::Duration::from_millis(750);
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_millis(self.timeouts.script_ms);
        let channel_closed = || WebDriverErrorResponse::unknown_error("Eval result channel closed");

        // Retry only when WebKit reclaims the completion before a result was delivered; `timeout_at`
        // bounds the whole sequence, so `Elapsed` (below) is the single script-timeout path.
        let settled = tokio::time::timeout_at(deadline, async {
            for attempt in 0..MAX_ATTEMPTS {
                let fail_rx = self
                    .dispatch_eval_attempt(&wrapper, &id, &registry, attempt)
                    .map_err(|e| WebDriverErrorResponse::javascript_error(&e, None))?;
                tokio::select! {
                    r = &mut rx => return r.map_err(|_| channel_closed()),
                    _ = fail_rx => {
                        if attempt + 1 == MAX_ATTEMPTS {
                            // Last attempt reclaimed: keep waiting for a late post until the deadline.
                            return (&mut rx).await.map_err(|_| channel_closed());
                        }
                        // Race a late post against the grace: if the script actually ran and posts
                        // here, return it — re-dispatching would execute the script (and any mocks it
                        // hits) a second time. Only re-dispatch once the grace elapses with no result.
                        tokio::select! {
                            r = &mut rx => return r.map_err(|_| channel_closed()),
                            _ = tokio::time::sleep(RECLAIM_GRACE) => {}
                        }
                    }
                }
            }
            Err(WebDriverErrorResponse::script_timeout()) // unreachable: the final attempt returns above
        })
        .await;

        let result =
            settled.unwrap_or_else(|_elapsed| Err(WebDriverErrorResponse::script_timeout()));
        if result.is_err() {
            registry.cancel(&id);
        }
        result
    }

    // =========================================================================
    // Screenshots
    // =========================================================================

    async fn take_screenshot(&self) -> Result<String, WebDriverErrorResponse> {
        let (tx, rx) = oneshot::channel();

        let result = self.window.with_webview(move |webview| unsafe {
            let wk_webview: &WKWebView = &*webview.inner().cast();
            let mtm = MainThreadMarker::new_unchecked();
            let config = WKSnapshotConfiguration::new(mtm);

            let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let response = if !error.is_null() {
                    let error_ref = &*error;
                    Err(describe_ns_error(error_ref))
                } else if image.is_null() {
                    Err("No image returned".to_string())
                } else {
                    let image_ref = &*image;
                    image_to_png_base64(image_ref)
                };

                if let Ok(mut guard) = tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(response);
                    }
                }
            });

            wk_webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
        });

        if let Err(e) = result {
            return Err(WebDriverErrorResponse::unknown_error(&e.to_string()));
        }

        let timeout = std::time::Duration::from_millis(self.timeouts.script_ms);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(base64))) => Ok(base64),
            Ok(Ok(Err(error))) => Err(WebDriverErrorResponse::unknown_error(&error)),
            Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error("Channel closed")),
            Err(_) => Err(WebDriverErrorResponse::script_timeout()),
        }
    }

    async fn take_element_screenshot(
        &self,
        js_var: &str,
    ) -> Result<String, WebDriverErrorResponse> {
        // For element screenshots, we use JavaScript canvas approach
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}

                // Use html2canvas-like approach if available, otherwise scroll into view
                el.scrollIntoView({{ block: 'center', inline: 'center' }});

                // Return element bounds for clipping
                var rect = el.getBoundingClientRect();
                return {{
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                }};
            }})()"
        );
        self.evaluate_js(&script).await?;

        self.take_screenshot().await
    }

    // =========================================================================
    // Print
    // =========================================================================

    async fn print_page(&self, options: PrintOptions) -> Result<String, WebDriverErrorResponse> {
        // First, inject CSS @page rules for print settings
        let page_width = options.page_width.unwrap_or(21.0);
        let page_height = options.page_height.unwrap_or(29.7);
        let margin_top = options.margin_top.unwrap_or(1.0);
        let margin_bottom = options.margin_bottom.unwrap_or(1.0);
        let margin_left = options.margin_left.unwrap_or(1.0);
        let margin_right = options.margin_right.unwrap_or(1.0);
        let orientation = options.orientation.as_deref().unwrap_or("portrait");

        // Inject @page CSS rules
        let css_script = format!(
            r"(function() {{
                var style = document.createElement('style');
                style.id = '__webdriver_print_style';
                style.textContent = `
                    @page {{
                        size: {page_width}cm {page_height}cm {orientation};
                        margin: {margin_top}cm {margin_right}cm {margin_bottom}cm {margin_left}cm;
                    }}
                    @media print {{
                        body {{
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }}
                    }}
                `;
                document.head.appendChild(style);
                return true;
            }})()"
        );
        self.evaluate_js(&css_script).await?;

        // Now create PDF using WKWebView's native API
        let (tx, rx) = oneshot::channel();

        let result = self.window.with_webview(move |webview| unsafe {
            let wk_webview: &WKWebView = &*webview.inner().cast();
            let mtm = MainThreadMarker::new_unchecked();

            // Create PDF configuration
            let config = WKPDFConfiguration::new(mtm);
            // Note: WKPDFConfiguration only has rect and allowTransparentBackground
            // Page size/margins are handled via CSS @page rules above

            let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
            let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let response = if !error.is_null() {
                    let error_ref = &*error;
                    Err(describe_ns_error(error_ref))
                } else if data.is_null() {
                    Err("No PDF data returned".to_string())
                } else {
                    let data_ref = &*data;
                    let bytes = data_ref.to_vec();
                    Ok(bytes)
                };

                if let Ok(mut guard) = tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(response);
                    }
                }
            });

            wk_webview.createPDFWithConfiguration_completionHandler(Some(&config), &block);
        });

        if let Err(e) = result {
            return Err(WebDriverErrorResponse::unknown_error(&e.to_string()));
        }

        // Wait for result
        let timeout = std::time::Duration::from_millis(self.timeouts.script_ms);
        let pdf_result = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(bytes))) => Ok(bytes),
            Ok(Ok(Err(error))) => Err(WebDriverErrorResponse::unknown_error(&error)),
            Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error("Channel closed")),
            Err(_) => Err(WebDriverErrorResponse::script_timeout()),
        };

        // Clean up injected style
        let _ = self
            .evaluate_js(
                r"(function() {
                var style = document.getElementById('__webdriver_print_style');
                if (style) style.remove();
                return true;
            })()",
            )
            .await;

        // Return base64 encoded PDF
        pdf_result.map(|bytes| BASE64_STANDARD.encode(&bytes))
    }
}

// =============================================================================
// Utility Functions
// =============================================================================

/// Convert `NSImage` to PNG and encode as base64
unsafe fn image_to_png_base64(image: &NSImage) -> Result<String, String> {
    let tiff_data: Option<objc2::rc::Retained<NSData>> = image.TIFFRepresentation();
    let tiff_data = tiff_data.ok_or("Failed to get TIFF representation")?;

    let bitmap_rep = NSBitmapImageRep::imageRepWithData(&tiff_data)
        .ok_or("Failed to create bitmap image rep")?;

    let empty_dict: objc2::rc::Retained<NSDictionary<NSString>> = NSDictionary::new();
    let png_data: Option<objc2::rc::Retained<NSData>> =
        bitmap_rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty_dict);
    let png_data = png_data.ok_or("Failed to convert to PNG")?;

    let bytes = png_data.to_vec();
    Ok(BASE64_STANDARD.encode(&bytes))
}

/// Build a diagnostic string for an `NSError` returned by a `WKWebView` completion handler.
///
/// `localizedDescription` for a script failure is frequently the opaque
/// "A JavaScript exception occurred." with no detail. WebKit stashes the real
/// exception text (and source location) in `userInfo` under the `WKJavaScriptException*`
/// keys, so surface those when present. Without this, a script failure on the embedded
/// executor is undiagnosable from the WDIO side (all we get back is the opaque string).
unsafe fn describe_ns_error(error: &NSError) -> String {
    let mut out = format!("{} (code {})", error.localizedDescription(), error.code());

    let user_info = error.userInfo();
    let get = |key: &str| -> Option<String> {
        let ns_key = NSString::from_str(key);
        // v is Retained<AnyObject>; ns_object_to_json takes &AnyObject. The explicit
        // unsafe block is required because a closure body does not inherit the enclosing
        // unsafe fn's context.
        user_info
            .objectForKey(&ns_key)
            .and_then(|v| match unsafe { ns_object_to_json(&v) } {
                Value::String(s) if !s.is_empty() => Some(s),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
    };

    if let Some(message) = get("WKJavaScriptExceptionMessage") {
        out.push_str(": ");
        out.push_str(&message);
    }
    if let (Some(line), Some(column)) = (
        get("WKJavaScriptExceptionLineNumber"),
        get("WKJavaScriptExceptionColumnNumber"),
    ) {
        out.push_str(&format!(" @ {line}:{column}"));
    }

    out
}

/// Convert an `NSObject` to a JSON value
pub(super) unsafe fn ns_object_to_json(obj: &AnyObject) -> Value {
    use objc2_foundation::NSString as NSStr;

    let class = obj.class();
    let class_name = class.name().to_str().unwrap_or("");

    if class_name.contains("String") {
        let ns_str: &NSStr = &*std::ptr::from_ref::<AnyObject>(obj).cast::<NSStr>();
        return Value::String(ns_str.to_string());
    }

    if class_name.contains("Number") || class_name.contains("Boolean") {
        use objc2::msg_send;
        use objc2::runtime::Bool;

        if class_name.contains("Boolean") {
            let bool_val: Bool = msg_send![obj, boolValue];
            return Value::Bool(bool_val.as_bool());
        }

        let double_val: f64 = msg_send![obj, doubleValue];
        let int_val: i64 = msg_send![obj, longLongValue];

        #[allow(clippy::cast_precision_loss)]
        if (int_val as f64 - double_val).abs() < f64::EPSILON {
            return Value::Number(serde_json::Number::from(int_val));
        } else if let Some(n) = serde_json::Number::from_f64(double_val) {
            return Value::Number(n);
        }
        return Value::Null;
    }

    if class_name.contains("Array") {
        use objc2::msg_send;

        let count: usize = msg_send![obj, count];
        let mut arr = Vec::new();
        for i in 0..count {
            let item: *mut AnyObject = msg_send![obj, objectAtIndex: i];
            if !item.is_null() {
                arr.push(ns_object_to_json(&*item));
            }
        }
        return Value::Array(arr);
    }

    if class_name.contains("Dictionary") {
        use objc2::msg_send;

        let keys: *mut AnyObject = msg_send![obj, allKeys];
        if keys.is_null() {
            return Value::Object(serde_json::Map::new());
        }

        let count: usize = msg_send![keys, count];
        let mut map = serde_json::Map::new();

        for i in 0..count {
            let key: *mut AnyObject = msg_send![keys, objectAtIndex: i];
            if key.is_null() {
                continue;
            }

            let key_class = (&*key).class().name().to_str().unwrap_or("");
            if !key_class.contains("String") {
                continue;
            }

            let ns_key: &NSStr = &*key.cast_const().cast::<NSStr>();
            let key_str = ns_key.to_string();

            let val: *mut AnyObject = msg_send![obj, objectForKey: key];
            if !val.is_null() {
                map.insert(key_str, ns_object_to_json(&*val));
            }
        }
        return Value::Object(map);
    }

    if class_name.contains("Null") {
        return Value::Null;
    }

    Value::Null
}

// =============================================================================
// Native UI Delegate for JavaScript Alerts
// =============================================================================

/// Instance variables for UI delegate - stores per-window alert state
struct WebDriverUIDelegateIvars {
    alert_state: Arc<AlertState>,
}

// SAFETY: Arc<AlertState> is Send + Sync
unsafe impl Send for WebDriverUIDelegateIvars {}
unsafe impl Sync for WebDriverUIDelegateIvars {}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "WebDriverUIDelegate"]
    #[ivars = WebDriverUIDelegateIvars]
    struct WebDriverUIDelegate;

    unsafe impl NSObjectProtocol for WebDriverUIDelegate {}

    #[allow(non_snake_case)]
    unsafe impl WKUIDelegate for WebDriverUIDelegate {
        /// Handle JavaScript `alert()` calls
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn webView_runJavaScriptAlertPanelWithMessage_initiatedByFrame_completionHandler(
            &self,
            _webview: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            let message_str = message.to_string();
            tracing::debug!("Intercepted alert: {message_str}");

            // Create channel for WebDriver response
            let (tx, rx) = std::sync::mpsc::channel();

            // Store alert state with responder (using per-window state from ivars)
            self.ivars().alert_state.set_pending(PendingAlert {
                message: message_str,
                default_text: None,
                alert_type: AlertType::Alert,
                responder: tx,
            });

            // Wait for accept/dismiss (with timeout)
            let timeout = std::time::Duration::from_secs(30);
            let _ = rx.recv_timeout(timeout);

            completion_handler.call(());
        }

        /// Handle JavaScript `confirm()` calls
        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn webView_runJavaScriptConfirmPanelWithMessage_initiatedByFrame_completionHandler(
            &self,
            _webview: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            completion_handler: &DynBlock<dyn Fn(objc2::runtime::Bool)>,
        ) {
            let message_str = message.to_string();
            tracing::debug!("Intercepted confirm: {message_str}");

            // Create channel for WebDriver response
            let (tx, rx) = std::sync::mpsc::channel();

            // Store confirm state with responder (using per-window state from ivars)
            self.ivars().alert_state.set_pending(PendingAlert {
                message: message_str,
                default_text: None,
                alert_type: AlertType::Confirm,
                responder: tx,
            });

            // Wait for accept/dismiss (with timeout)
            let timeout = std::time::Duration::from_secs(30);
            let response = rx.recv_timeout(timeout);

            // Return true if accepted, false if dismissed or timeout
            let accepted = response.map(|r| r.accepted).unwrap_or(true);

            completion_handler.call((objc2::runtime::Bool::from(accepted),));
        }

        /// Handle JavaScript `prompt()` calls
        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn webView_runJavaScriptTextInputPanelWithPrompt_defaultText_initiatedByFrame_completionHandler(
            &self,
            _webview: &WKWebView,
            prompt: &NSString,
            default_text: Option<&NSString>,
            _frame: &WKFrameInfo,
            completion_handler: &DynBlock<dyn Fn(*mut NSString)>,
        ) {
            let prompt_str = prompt.to_string();
            let default = default_text.map(std::string::ToString::to_string);
            tracing::debug!("Intercepted prompt: {prompt_str}");

            // Create channel for WebDriver response
            let (tx, rx) = std::sync::mpsc::channel();

            // Store prompt state with responder (using per-window state from ivars)
            self.ivars().alert_state.set_pending(PendingAlert {
                message: prompt_str,
                default_text: default.clone(),
                alert_type: AlertType::Prompt,
                responder: tx,
            });

            // Wait for accept/dismiss (with timeout)
            let timeout = std::time::Duration::from_secs(30);
            let response = rx.recv_timeout(timeout);

            // Return the prompt text if accepted, null if dismissed
            let result: *mut NSString = match response {
                Ok(r) if r.accepted => {
                    let text = r.prompt_text.or(default).unwrap_or_default();
                    let ns_str = NSString::from_str(&text);
                    Retained::into_raw(ns_str)
                }
                _ => std::ptr::null_mut(), // Dismissed or timeout = null (cancel)
            };

            completion_handler.call((result,));
        }
    }
);

impl WebDriverUIDelegate {
    /// # Safety
    /// Must be called from the main thread.
    unsafe fn new(alert_state: Arc<AlertState>) -> Retained<Self> {
        let mtm = MainThreadMarker::new_unchecked();
        let this = Self::alloc(mtm);
        let this = this.set_ivars(WebDriverUIDelegateIvars { alert_state });
        msg_send![super(this), init]
    }
}

struct EvalMessageHandlerIvars {
    registry: Arc<EvalResultRegistry>,
}

// SAFETY: Arc<EvalResultRegistry> is Send + Sync
unsafe impl Send for EvalMessageHandlerIvars {}
unsafe impl Sync for EvalMessageHandlerIvars {}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "WdioEvalMessageHandler"]
    #[ivars = EvalMessageHandlerIvars]
    struct EvalMessageHandler;

    unsafe impl NSObjectProtocol for EvalMessageHandler {}

    #[allow(non_snake_case)]
    unsafe impl WKScriptMessageHandler for EvalMessageHandler {
        /// Delivers `{ id, result }` posted by the DirectEval wrapper to the waiting executor.
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn userContentController_didReceiveScriptMessage(
            &self,
            _controller: &WKUserContentController,
            message: &WKScriptMessage,
        ) {
            let json = unsafe { ns_object_to_json(&message.body()) };
            let (Some(id), Some(result)) = (
                json.get("id").and_then(Value::as_str),
                json.get("result").cloned(),
            ) else {
                tracing::warn!("wdioEvalResult message missing id/result");
                return;
            };
            self.ivars().registry.complete(id, result);
        }
    }
);

impl EvalMessageHandler {
    /// # Safety
    /// Must be called from the main thread.
    unsafe fn new(registry: Arc<EvalResultRegistry>) -> Retained<Self> {
        let mtm = MainThreadMarker::new_unchecked();
        let this = Self::alloc(mtm);
        let this = this.set_ivars(EvalMessageHandlerIvars { registry });
        msg_send![super(this), init]
    }
}
