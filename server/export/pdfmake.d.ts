// Minimal ambient declaration for pdfmake's Node printer (no @types published for v0.2 server API).
declare module "pdfmake" {
  class PdfPrinter {
    constructor(fonts: Record<string, any>);
    createPdfKitDocument(docDefinition: any, options?: any): any;
  }
  export = PdfPrinter;
}
declare module "pdfmake/build/vfs_fonts.js" {
  const content: any;
  export = content;
}
