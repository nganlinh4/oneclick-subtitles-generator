'use strict';

// Schema, ownership, and layout names of the managed E2E frontend snapshot cache.

const SNAPSHOT_SCHEMA_VERSION = 1;
const HASH_ALGORITHM = 'sha256';
const MANAGED_CACHE_SCHEMA_VERSION = 1;
const MANAGED_CACHE_OWNER = 'oneclick-subtitles-generator';
const MANAGED_ENTRY_MARKER = '.osg-cache-entry.json';
const MANAGED_AREA_MARKER = '.osg-cache-area.json';
const MANAGED_LEASE_MARKER = '.osg-cache-lease';
const MANAGED_FRONTEND_LANE = 'frontend-e2e';
const MANAGED_LANE_GROUP = 'e2e';
const ID_PATTERN = /^[0-9a-f]{32}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLISHER_LAYOUT_MARKER = '.osg-frontend-snapshot-cache.json';
const PUBLISHER_LAYOUT_KIND = 'e2e-frontend-snapshots';
const PUBLISHER_JOURNAL_ROOT = '.osg-frontend-journals';
const PUBLISHER_TRASH_ROOT = '.osg-frontend-trash';
const PUBLISHER_WORKSPACE_ROOT = '.osg-frontend-workspaces';
const RETENTION_RECEIPT_NAME = 'retention.json';
const RETAINED_SNAPSHOT_COUNT = 2;

module.exports = {
  HASH_ALGORITHM,
  HASH_PATTERN,
  ID_PATTERN,
  MANAGED_AREA_MARKER,
  MANAGED_CACHE_OWNER,
  MANAGED_CACHE_SCHEMA_VERSION,
  MANAGED_ENTRY_MARKER,
  MANAGED_FRONTEND_LANE,
  MANAGED_LANE_GROUP,
  MANAGED_LEASE_MARKER,
  PUBLISHER_JOURNAL_ROOT,
  PUBLISHER_LAYOUT_KIND,
  PUBLISHER_LAYOUT_MARKER,
  PUBLISHER_TRASH_ROOT,
  PUBLISHER_WORKSPACE_ROOT,
  RETAINED_SNAPSHOT_COUNT,
  RETENTION_RECEIPT_NAME,
  SNAPSHOT_SCHEMA_VERSION,
};
