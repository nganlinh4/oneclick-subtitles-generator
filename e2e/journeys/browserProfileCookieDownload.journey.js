/*
 * The product flow and oracles are intentionally shared with the cookie-file boundary. The
 * workflow name selects a separately compiled automation authority: this lane makes yt-dlp read
 * Chrome's real cookie database from a disposable headless profile beneath the isolated run root.
 */
import './authenticatedCookieDownload.journey.js';
