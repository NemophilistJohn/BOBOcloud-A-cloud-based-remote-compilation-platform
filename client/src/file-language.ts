export function languageForActiveTab(language: unknown, filename: unknown): string {
  if (/\.ipynb$/i.test(String(filename || ''))) return 'python';
  return typeof language === 'string' ? language : String(language || '');
}
