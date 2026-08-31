/** Tailwind build for FSN.
 *  The app used to load https://cdn.tailwindcss.com (the Play CDN), which
 *  compiles in the browser, cannot carry SRI, and puts a third-party origin
 *  in the critical path of a page that holds ESPN session cookies in
 *  localStorage. This config produces the same utilities ahead of time.
 *
 *  Rebuild after adding Tailwind classes:  npm run build:css
 */
module.exports = {
  content: [
    './index.html',
    './league-media-studio.html',
  ],
  theme: { extend: {} },
  corePlugins: { preflight: true },
};
