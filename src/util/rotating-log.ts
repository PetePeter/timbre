import { createStream, type RotatingFileStream } from 'rotating-file-stream';

export function createRotatingLog(filePath: string, onError: (error: Error) => void): RotatingFileStream {
  const stream = createStream(filePath, { size: '5M', rotate: 1 });
  let reported = false;
  const reportError = (error: Error) => {
    if (reported) return;
    reported = true;
    try { onError(error); } catch { /* logging failures must not escape */ }
  };
  stream.on('error', reportError);
  stream.on('warning', reportError);
  return stream;
}
