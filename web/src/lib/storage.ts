/** localStorage, or undefined where touching it throws (blocked storage, some previews). */
export function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
