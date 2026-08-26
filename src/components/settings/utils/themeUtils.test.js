import { initializeTheme, toggleTheme } from './themeUtils';

it('initialization applies the effective fallback without persisting it', () => {
  const root = document.documentElement;
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const before = localStorage.getItem('theme');

  initializeTheme({ resolveTheme: () => 'dark', root });

  expect(root.getAttribute('data-theme')).toBe('dark');
  expect(localStorage.getItem('theme')).toBe(before);
  expect(setItem).not.toHaveBeenCalled();
  setItem.mockRestore();
});

it('a failed explicit toggle does not update React state', async () => {
  const setTheme = vi.fn();
  const failure = new Error('native write rejected');

  await expect(toggleTheme('dark', setTheme, {
    commitPreference: vi.fn().mockRejectedValue(failure),
  })).rejects.toBe(failure);

  expect(setTheme).not.toHaveBeenCalled();
});

it('a successful explicit toggle updates React only after the commit', async () => {
  const order = [];
  const setTheme = vi.fn(() => order.push('state'));
  const commitPreference = vi.fn(async () => order.push('native-and-mirror'));

  await expect(toggleTheme('dark', setTheme, { commitPreference })).resolves.toBe('light');

  expect(commitPreference).toHaveBeenCalledExactlyOnceWith('light');
  expect(setTheme).toHaveBeenCalledExactlyOnceWith('light');
  expect(order).toEqual(['native-and-mirror', 'state']);
});

it('forwards a dedicated projection warning without treating durable success as rejection', async () => {
  const setTheme = vi.fn();
  const onProjectionWarning = vi.fn();
  const commitPreference = vi.fn(async (_theme, options) => {
    options.onProjectionWarning({ status: 'committed-with-projection-warning' });
  });

  await expect(toggleTheme('dark', setTheme, {
    commitPreference,
    onProjectionWarning,
  })).resolves.toBe('light');

  expect(commitPreference).toHaveBeenCalledExactlyOnceWith('light', { onProjectionWarning });
  expect(onProjectionWarning).toHaveBeenCalledOnce();
  expect(setTheme).toHaveBeenCalledExactlyOnceWith('light');
});
