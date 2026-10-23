/** The stable `code` a native or service error carries, or null when it has none. */
export const errorCodeOf = (error) => (
  typeof error?.code === 'string' && error.code.length > 0 ? error.code : null
);
