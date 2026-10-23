// Quality re-download orchestration: the shared native URL download at the selected quality,
// progress, confirmation, and cancellation before and after native job registration.
import { act, renderHook } from '@testing-library/react';

import {
  cancelNativeVideoDownload,
  downloadNativeVideo,
} from '../../platform/nativeUrlDownloadAdapter';
import { createQualityRedownloadActivation } from './qualityRedownloadActivation';
import useQualityProgressTracking from './useQualityProgressTracking';

vi.mock('../../platform/nativeUrlDownloadAdapter', () => ({
  cancelNativeVideoDownload: vi.fn(),
  downloadNativeVideo: vi.fn(),
}));
vi.mock('./qualityRedownloadActivation', () => ({
  createQualityRedownloadActivation: vi.fn(),
}));

const JOB_ID = '01890f39-7b62-7c4e-8c9a-000000000202';
const media = Object.freeze({ native: true, assetId: 'output' });
const activation = Object.freeze({
  validateOwnership: vi.fn(),
  admitActivation: vi.fn(),
  publishActivation: vi.fn(),
  rollbackActivation: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  createQualityRedownloadActivation.mockResolvedValue(activation);
});

const renderTracking = () => {
  const props = {
    setIsRedownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    onConfirm: vi.fn(),
    handleClose: vi.fn(),
    onMediaReplaced: vi.fn(),
  };
  const { result } = renderHook(() => useQualityProgressTracking(props));
  return { props, result };
};

it('downloads the selected quality through the shared transaction and confirms the new media', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'opera');
  downloadNativeVideo.mockImplementation(async (request) => {
    request.onStarted(JOB_ID);
    request.onProgress(25);
    return media;
  });
  const { props, result } = renderTracking();

  let outcome;
  await act(async () => {
    outcome = await result.current.startQualityDownloadWithId('1080p', 'https://example.com/video', 'id');
  });

  expect(createQualityRedownloadActivation).toHaveBeenCalledExactlyOnceWith({
    url: 'https://example.com/video',
    onMediaReplaced: props.onMediaReplaced,
  });
  expect(downloadNativeVideo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    ...activation,
    url: 'https://example.com/video',
    cookieSource: 'opera',
    quality: '1080p',
    signal: expect.any(AbortSignal),
  }));
  expect(props.setDownloadProgress).toHaveBeenCalledWith(25);
  expect(props.setDownloadProgress).toHaveBeenLastCalledWith(100);
  expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith('redownload', {
    quality: '1080p',
    url: 'https://example.com/video',
    videoId: 'id',
    nativeMedia: media,
  });
  expect(props.handleClose).toHaveBeenCalledOnce();
  expect(outcome).toEqual({ success: true, nativeMedia: media });
});

it('cancels a registered job through the adapter so a claim already in progress stays authoritative', async () => {
  let finish;
  downloadNativeVideo.mockImplementation(async (request) => {
    request.onStarted(JOB_ID);
    return new Promise((resolve) => { finish = resolve; });
  });
  cancelNativeVideoDownload.mockResolvedValue(false);
  const { props, result } = renderTracking();

  let operation;
  act(() => {
    operation = result.current.startQualityDownloadWithId('720p', 'https://example.com/v', 'id');
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => result.current.handleCancelRedownload());
  expect(cancelNativeVideoDownload).toHaveBeenCalledExactlyOnceWith(JOB_ID);
  expect(downloadNativeVideo.mock.calls[0][0].signal.aborted).toBe(false);

  finish(media);
  await act(async () => {
    await expect(operation).resolves.toEqual({ success: true, nativeMedia: media });
  });
  expect(props.onConfirm).toHaveBeenCalledOnce();
});

it('reports a cancellation the adapter resolved without media', async () => {
  downloadNativeVideo.mockResolvedValue(null);
  const { props, result } = renderTracking();

  await act(async () => {
    await expect(result.current.startQualityDownloadWithId('720p', 'https://example.com/v', 'id'))
      .resolves.toEqual({ success: false, cancelled: true });
  });
  expect(props.onConfirm).not.toHaveBeenCalled();
});

it('withdraws an unregistered request through its abort signal', async () => {
  downloadNativeVideo.mockImplementation((request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }));
  const { props, result } = renderTracking();

  let operation;
  act(() => {
    operation = result.current.startQualityDownloadWithId('720p', 'https://example.com/v', 'id');
  });
  await vi.waitFor(() => expect(downloadNativeVideo).toHaveBeenCalledOnce());
  await act(async () => result.current.handleCancelRedownload());

  await act(async () => {
    await expect(operation).resolves.toEqual({ success: false, cancelled: true });
  });
  expect(cancelNativeVideoDownload).not.toHaveBeenCalled();
  expect(props.setIsRedownloading).toHaveBeenCalledWith(false);
  expect(props.onConfirm).not.toHaveBeenCalled();
});

it('surfaces a refused activation without starting a download', async () => {
  const refusal = Object.assign(new Error('not the active media source'), {
    code: 'qualityRedownloadOwnershipLost',
  });
  createQualityRedownloadActivation.mockRejectedValue(refusal);
  const { result } = renderTracking();

  await act(async () => {
    await expect(result.current.startQualityDownloadWithId('720p', 'https://example.com/v', 'id'))
      .rejects.toBe(refusal);
  });
  expect(downloadNativeVideo).not.toHaveBeenCalled();
});
