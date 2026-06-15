# public/ 靜態資源

放在此資料夾的檔案會在 `quasar build` 時**原封不動複製到 `dist/spa` 根目錄**，並由 Cloudflare 靜態資源以根路徑提供。

## 自訂網站 icon

把你的 icon 檔命名為 `favicon.ico` 放在此資料夾：

```
public/favicon.ico   →   正式網址 https://<你的網域>/favicon.ico
```

`index.html` 已加上 `<link rel="icon" href="/favicon.ico">` 連結，放好檔案後 `pnpm build` 即生效。

> 若想同時支援 PNG / SVG（較高解析度），可一併放 `public/icon.png` 等檔，
> 並在 `index.html` 加對應的 `<link rel="icon" type="image/png" href="/icon.png">`。
