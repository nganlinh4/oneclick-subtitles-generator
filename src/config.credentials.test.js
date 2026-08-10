beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

it('never snapshots a legacy Gemini secret into frontend configuration', async () => {
  localStorage.setItem('gemini_api_key', 'must-not-enter-config');
  const getItem = vi.spyOn(Storage.prototype, 'getItem');
  const config = await import('./config');

  expect(config.GEMINI_API_KEY).toBe('');
  expect(getItem).not.toHaveBeenCalledWith('gemini_api_key');
  getItem.mockRestore();
});
