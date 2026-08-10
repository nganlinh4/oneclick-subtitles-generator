use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize};
use uuid::{Uuid, Variant, Version};

use crate::{BrowserCookieSource, DownloadError, MediaInventory, Result, ValidatedMediaUrl};

pub const MAX_INVENTORY_CAPABILITIES: usize = 64;
const INVENTORY_TTL: Duration = Duration::from_mins(15);

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct InventoryId(Uuid);

impl InventoryId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self> {
        if value.get_version() == Some(Version::SortRand) && value.get_variant() == Variant::RFC4122
        {
            Ok(Self(value))
        } else {
            Err(DownloadError::InventoryNotFound)
        }
    }

    #[must_use]
    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for InventoryId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for InventoryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl fmt::Display for InventoryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl<'de> Deserialize<'de> for InventoryId {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Uuid::deserialize(deserializer)?;
        Self::from_uuid(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRegistration {
    pub id: InventoryId,
    pub expires_at_ms: u64,
}

#[derive(Clone)]
pub struct InventoryCapability {
    url: ValidatedMediaUrl,
    inventory: MediaInventory,
    cookies: BrowserCookieSource,
}

impl InventoryCapability {
    #[must_use]
    pub fn url(&self) -> &ValidatedMediaUrl {
        &self.url
    }

    #[must_use]
    pub fn inventory(&self) -> &MediaInventory {
        &self.inventory
    }

    #[must_use]
    pub const fn cookies(&self) -> BrowserCookieSource {
        self.cookies
    }
}

impl fmt::Debug for InventoryCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InventoryCapability")
            .field("url", &self.url)
            .field("inventory", &self.inventory)
            .field("cookies", &self.cookies)
            .finish()
    }
}

#[derive(Debug)]
struct Entry {
    capability: InventoryCapability,
    expires_at: Instant,
}

pub struct InventoryRegistry {
    entries: Mutex<HashMap<InventoryId, Entry>>,
    capacity: usize,
    ttl: Duration,
}

impl InventoryRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(MAX_INVENTORY_CAPABILITIES, INVENTORY_TTL)
    }

    fn with_limits(capacity: usize, ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            capacity,
            ttl,
        }
    }

    pub fn insert(
        &self,
        url: ValidatedMediaUrl,
        inventory: MediaInventory,
        cookies: BrowserCookieSource,
    ) -> Result<InventoryRegistration> {
        self.insert_at(url, inventory, cookies, Instant::now(), wall_clock_ms())
    }

    pub fn resolve(&self, id: InventoryId) -> Result<InventoryCapability> {
        self.resolve_at(id, Instant::now())
    }

    fn insert_at(
        &self,
        url: ValidatedMediaUrl,
        inventory: MediaInventory,
        cookies: BrowserCookieSource,
        now: Instant,
        wall_clock_ms: u64,
    ) -> Result<InventoryRegistration> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| DownloadError::InventoryRegistryUnavailable)?;
        entries.retain(|_, entry| entry.expires_at > now);
        if entries.len() >= self.capacity {
            return Err(DownloadError::InventoryRegistryFull);
        }
        let id = InventoryId::new();
        let expires_at = now
            .checked_add(self.ttl)
            .ok_or(DownloadError::InventoryRegistryUnavailable)?;
        entries.insert(
            id,
            Entry {
                capability: InventoryCapability {
                    url,
                    inventory,
                    cookies,
                },
                expires_at,
            },
        );
        Ok(InventoryRegistration {
            id,
            expires_at_ms: wall_clock_ms
                .saturating_add(u64::try_from(self.ttl.as_millis()).unwrap_or(u64::MAX)),
        })
    }

    fn resolve_at(&self, id: InventoryId, now: Instant) -> Result<InventoryCapability> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| DownloadError::InventoryRegistryUnavailable)?;
        let expired = entries
            .get(&id)
            .is_some_and(|entry| entry.expires_at <= now);
        if expired {
            entries.remove(&id);
            return Err(DownloadError::InventoryExpired);
        }
        entries
            .get(&id)
            .map(|entry| entry.capability.clone())
            .ok_or(DownloadError::InventoryNotFound)
    }
}

impl Default for InventoryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for InventoryRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let count = self.entries.lock().map_or(0, |entries| entries.len());
        formatter
            .debug_struct("InventoryRegistry")
            .field("entry_count", &count)
            .field("capacity", &self.capacity)
            .field("ttl", &self.ttl)
            .finish()
    }
}

fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::Arc;

    use crate::{AddressResolver, UrlPolicy, UrlValidator};

    use super::*;

    #[derive(Clone, Debug)]
    struct PublicDns;

    impl AddressResolver for PublicDns {
        fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
            Ok(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])
        }
    }

    fn capability(index: usize) -> (ValidatedMediaUrl, MediaInventory) {
        let url = UrlValidator::new(PublicDns, UrlPolicy::SupportedSitesOnly)
            .validate(&format!("https://youtube.com/watch?v={index}"))
            .expect("validated URL");
        let inventory = MediaInventory::from_json(
            &url,
            br#"{"title":"clip","formats":[{"format_id":"18","ext":"mp4","vcodec":"h264","acodec":"aac"}]}"#,
        )
        .expect("inventory");
        (url, inventory)
    }

    #[test]
    fn capabilities_expire_deterministically_and_never_serialize_urls() {
        let registry = InventoryRegistry::with_limits(2, Duration::from_secs(30));
        let now = Instant::now();
        let (url, inventory) = capability(1);
        let registration = registry
            .insert_at(url, inventory, BrowserCookieSource::Chrome, now, 100)
            .expect("register capability");

        assert_eq!(registration.expires_at_ms, 30_100);
        assert_eq!(
            registry
                .resolve_at(registration.id, now + Duration::from_secs(29))
                .expect("live capability")
                .cookies(),
            BrowserCookieSource::Chrome
        );
        assert!(matches!(
            registry.resolve_at(registration.id, now + Duration::from_secs(30)),
            Err(DownloadError::InventoryExpired)
        ));
        let serialized = serde_json::to_string(&registration).expect("registration JSON");
        assert!(!serialized.contains("youtube"));
        assert!(!serialized.contains("url"));
    }

    #[test]
    fn concurrent_insertion_cannot_exceed_the_registry_capacity() {
        let registry = Arc::new(InventoryRegistry::with_limits(4, Duration::from_secs(30)));
        let mut threads = Vec::new();
        for index in 0..16 {
            let registry = Arc::clone(&registry);
            threads.push(std::thread::spawn(move || {
                let (url, inventory) = capability(index);
                registry.insert(url, inventory, BrowserCookieSource::None)
            }));
        }
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().expect("registry writer"))
            .collect();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 4);
        assert!(
            results
                .iter()
                .filter(|result| result.is_err())
                .all(|result| { matches!(result, Err(DownloadError::InventoryRegistryFull)) })
        );
    }

    #[test]
    fn rejects_non_v7_inventory_ids_at_deserialization() {
        let legacy = Uuid::new_v4();
        assert!(serde_json::from_str::<InventoryId>(&format!("\"{legacy}\"")).is_err());
    }
}
