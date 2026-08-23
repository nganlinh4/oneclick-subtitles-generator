import { getCurrentMediaId } from './mediaId';

describe('getCurrentMediaId', () => {
  afterEach(() => localStorage.clear());

  test('never promotes browser storage into desktop media authority', () => {
    localStorage.setItem('current_video_url', 'https://youtu.be/dQw4w9WgXcQ');
    localStorage.setItem('current_file_cache_id', 'file-abc');
    expect(getCurrentMediaId()).toBe(null);
  });
});
