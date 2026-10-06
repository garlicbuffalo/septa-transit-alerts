// H.264 MP4s from JPEG frames with ffmpeg, the settings cta-insights used for
// its timelapses (ISC): 16 fps, libx264 preset fast, CRF 23, yuv420p, even
// dimensions, faststart. Frames are piped in, so none touch the disk.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FPS = 16;

/** True when the ffmpeg binary runs. */
export function ffmpegAvailable(ffmpeg = 'ffmpeg') {
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpeg, ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Encode frames to an MP4.
 * @param {AsyncIterable<Buffer> | Iterable<Buffer>} frames JPEG images, all the same size
 * @param {{ fps?: number, ffmpeg?: string, workDir?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function encodeMp4(frames, { fps = FPS, ffmpeg = 'ffmpeg', workDir = tmpdir() } = {}) {
  const dir = await mkdtemp(join(workDir, 'septa-video-'));
  const out = join(dir, 'out.mp4');
  try {
    const proc = spawn(
      ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        String(fps),
        '-c:v',
        'mjpeg',
        '-i',
        '-',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        out,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    const exited = new Promise((resolve) => proc.once('close', resolve));
    const done = new Promise((resolve, reject) => {
      proc.on('error', reject);
      exited.then((code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
      );
    });
    // An early ffmpeg exit surfaces through `done`; don't let EPIPE throw.
    proc.stdin.on('error', () => {});
    let n = 0;
    for await (const frame of frames) {
      if (!proc.stdin.write(frame)) {
        await Promise.race([new Promise((resolve) => proc.stdin.once('drain', resolve)), exited]);
      }
      n++;
    }
    proc.stdin.end();
    await done;
    if (n === 0) throw new Error('no frames to encode');
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
