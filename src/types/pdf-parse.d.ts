// 类型声明 —— pdf-parse@1.1.1 主入口会在 module load 时尝试读 ./test/data/05-versions-space.pdf，
// Step 4 走 pdf-parse/lib/pdf-parse.js 直导入，绕开那段 debug 代码。
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
    text: string;
    version: string;
  }
  function pdfParse(
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): Promise<PdfResult>;
  export default pdfParse;
}

declare module 'pdf-parse' {
  interface PdfResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
    text: string;
    version: string;
  }
  function pdfParse(
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): Promise<PdfResult>;
  export default pdfParse;
}