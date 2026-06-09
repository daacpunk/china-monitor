// Optional dependency: nodemailer is lazy-imported only when SMTP is configured.
// Ambient declaration so the type-check passes without requiring the package.
declare module "nodemailer";
