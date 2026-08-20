import {
  ExternalLinkError,
  installDesktopExternalLinkGuard,
  openDesktopExternalLink,
} from './externalLinkService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(),
}));

describe('externalLinkService', () => {
  it('sends only a closed target identifier to the native host', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);
    await openDesktopExternalLink('https://github.com/nganlinh4', {
      nativeRuntime: () => true,
      invokeCommand,
    });
    expect(invokeCommand).toHaveBeenCalledWith('open_external_link', {
      link: 'creatorGithub',
    });
  });

  it.each([
    'javascript:alert(1)',
    'https://github.com.attacker.invalid/nganlinh4',
    'https://github.com/nganlinh4/extra',
    'https://attacker.invalid/?next=https://github.com/nganlinh4',
    'mailto:attacker@example.com',
  ])('rejects unlisted destination %s before IPC', async (destination) => {
    const invokeCommand = vi.fn();
    await expect(openDesktopExternalLink(destination, {
      nativeRuntime: () => true,
      invokeCommand,
    })).rejects.toMatchObject({ code: 'externalLinkNotAllowed' });
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it('re-sanitizes native transport failures', async () => {
    await expect(openDesktopExternalLink('https://genius.com/api-clients', {
      nativeRuntime: () => true,
      invokeCommand: vi.fn().mockRejectedValue(new Error('private host details')),
    })).rejects.toEqual(new ExternalLinkError('externalLinkUnavailable'));
  });

  it('intercepts desktop anchors and window.open without changing browser mode', async () => {
    const openLink = vi.fn().mockResolvedValue(undefined);
    const originalOpen = window.open;
    const cleanup = installDesktopExternalLinkGuard({
      nativeRuntime: () => true,
      openLink,
    });
    const anchor = document.createElement('a');
    anchor.href = 'https://aistudio.google.com/app/apikey';
    document.body.append(anchor);

    expect(anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    window.open('https://github.com/nganlinh4', '_blank');
    expect(openLink).toHaveBeenCalledWith('https://aistudio.google.com/app/apikey');
    expect(openLink).toHaveBeenCalledWith('https://github.com/nganlinh4');

    cleanup();
    anchor.remove();
    expect(window.open).toBe(originalOpen);

    const browserOpen = window.open;
    const browserCleanup = installDesktopExternalLinkGuard({ nativeRuntime: () => false, openLink });
    expect(window.open).toBe(browserOpen);
    browserCleanup();
  });
});
