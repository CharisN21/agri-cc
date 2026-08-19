// "Was this module run directly?" — correctly, on Windows as well as POSIX.
//
// The tempting one-liner (`import.meta.url === 'file://' + process.argv[1]`)
// is wrong on Windows: import.meta.url is file:///C:/... with three slashes,
// argv[1] is C:\... with backslashes, and they never match, so the entry point
// silently does nothing.
import { pathToFileURL } from 'node:url';

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  return moduleUrl === pathToFileURL(process.argv[1]).href;
}
