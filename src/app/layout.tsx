import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import {
  ProductPreferencesProvider,
  type ThemePreference,
} from "@/components/product-preferences-provider";
import type { Locale } from "@/i18n/types";

export const metadata: Metadata = {
  title: "IntentChord",
  description: "Governed AI action",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/intentchord-assets/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/intentchord-assets/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

function localePreference(value: string | undefined): Locale {
  return value === "ar" ? "ar" : "en";
}

function themePreference(value: string | undefined): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

/**
 * Root layout — pure global document shell.
 *
 * Contains ONLY: html/body, locale, theme, preferences, metadata.
 * Authentication is handled exclusively by (protected)/layout.tsx.
 */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const initialLocale = localePreference(cookieStore.get("intentchord-locale")?.value);
  const initialTheme = themePreference(cookieStore.get("intentchord-theme")?.value);
  const initialResolvedTheme = initialTheme === "dark" ? "dark" : "light";
  const preferenceScript = `(()=>{try{const c=(n)=>document.cookie.split('; ').find(v=>v.startsWith(n+'='))?.split('=').slice(1).join('='),sl=localStorage.getItem('intentchord-locale'),st=localStorage.getItem('intentchord-theme'),l=sl==='ar'||sl==='en'?sl:(c('intentchord-locale')==='ar'?'ar':'en'),t=st==='light'||st==='dark'||st==='system'?st:((c('intentchord-theme')==='light'||c('intentchord-theme')==='dark'||c('intentchord-theme')==='system')?c('intentchord-theme'):'system'),r=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t,e=document.documentElement;e.lang=l;e.dir=l==='ar'?'rtl':'ltr';e.dataset.theme=r;localStorage.setItem('intentchord-locale',l);localStorage.setItem('intentchord-theme',t)}catch{}})()`;

  return (
    <html
      lang={initialLocale}
      dir={initialLocale === "ar" ? "rtl" : "ltr"}
      data-theme={initialResolvedTheme}
      suppressHydrationWarning
    >
      <head><script dangerouslySetInnerHTML={{ __html: preferenceScript }} /></head>
      <body>
        <ProductPreferencesProvider initialLocale={initialLocale} initialTheme={initialTheme}>
          {children}
        </ProductPreferencesProvider>
      </body>
    </html>
  );
}
