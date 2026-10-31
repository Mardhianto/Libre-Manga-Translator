// Rawkuma - https://rawkuma.net
// Reader URL:
//   https://rawkuma.net/<series-slug>/chapter-39-2/
//   e.g. /dokushin-kizoku-wa-isekai-o-ouka-suru.../chapter-39-2/
// Title: typically "<Series> Chapter <N> - Rawkuma"
//
// Long-strip reader: all pages are rendered as stacked <img> tags inside
// [data-image-data] on a single URL, so pageIndex intentionally never
// matches and stays 0 - cache/context key degrades to chapter level.

export default {
  id: "rawkuma",
  domain: "rawkuma.net",
  seriesName: {
    regex: "^\\/([^/]+)\\/chapter",
    source: "path",
  },
  chapterId: {
    regex: "\\/chapter-([\\d.-]+)",
    source: "path",
  },
  pageIndex: {
    regex: "^$",
    source: "path",
  },
  containerSelector: "[data-chapter-type=\"manga\"]",
  imageSelector: "[data-image-data] img",
  pillPosition: "top-left",
  toolbarPosition: "top-left",
} satisfies SiteRule;
