// KLManga - https://klmanga.chat
// Reader URL:
//   https://klmanga.chat/manga-raw/<url-encoded-slug>/chapter-9/
//   e.g. /manga-raw/%e6%8a%98%e3%82%8a%e7%b4%99.../chapter-9/
// Title: not reliable (Japanese); all signals pulled from path.
//
// Long-strip / merged-page reader: images are injected via AJAX (z_do_ajax /
// decode_images). All pages share one URL, so pageIndex intentionally never
// matches and stays 0 - cache/context key degrades to chapter level.

export default {
  id: "klmanga",
  domain: "klmanga.chat",
  seriesName: {
    regex: "\\/manga-raw\\/([^/]+)\\/",
    source: "path",
  },
  chapterId: {
    regex: "\\/chapter-([\\d.]+)",
    source: "path",
  },
  pageIndex: {
    regex: "^$",
    source: "path",
  },
  containerSelector: ".z_content",
  imageSelector: ".z_content img",
  pillPosition: "top-left",
  toolbarPosition: "top-left",
} satisfies SiteRule;
