/** Hermes 全局补充声明（TS lib 未覆盖） */
declare function atob(data: string): string
declare function btoa(data: string): string
declare class TextDecoder {
  constructor(label?: string)
  decode(input: Uint8Array | ArrayBuffer, options?: { stream?: boolean }): string
}