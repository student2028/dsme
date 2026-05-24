/** WebContents.sendInputEvent payloads (Electron typings incomplete for some event shapes). */
export type WebContentsInputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown' | 'mouseUp'; x: number; y: number; button: 'left' | 'right' | 'middle'; clickCount: number }
  | { type: 'keyDown' | 'keyUp'; keyCode: string }
  | { type: string; [key: string]: unknown };
