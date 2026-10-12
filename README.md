# Tabdial

A speed dial for the new tab page of Chrome, Edge and Firefox: your sites as a grid of thumbnails, in groups and folders.

[Chrome](https://chromewebstore.google.com/detail/kdhebfdpijficfppoogjafaopboflpce) ·
[Edge](https://microsoftedge.microsoft.com/addons/detail/igaobiimdandbanlllpdehklfkljahde) ·
[Firefox](https://addons.mozilla.org/firefox/addon/tabdial/) ·
[Site and guide](https://nexuscortex.dev/tabdial/) ·
[Privacy policy](https://nexuscortex.dev/tabdial/privacy/) ·
[中文](#中文)

## What is here

`src/` is the extension as the stores get it: plain JavaScript, no build step, no minifier, no libraries. Each version sent to the stores has a tag here (`v0.4.1`), so what changed between two versions is a `git diff` between two tags.

## Checking a store package against this repository

Unpack the package your browser installed and compare it with the tag of the same version.

- **Chrome, Edge:** the package is `src/`. The store adds a `_metadata/` folder and lines of its own to `manifest.json` (Edge: `update_url`).
- **Firefox:** the package is what `npm run zip:firefox` makes: `src/` with a few lines of `manifest.json` changed for Firefox (the script is in `package.json`). Mozilla adds a `META-INF/` folder.

Every other file is the same, byte for byte.

## Running it from source

- **Chrome, Edge:** `chrome://extensions` → Developer mode → Load unpacked → `src/`.
- **Firefox:** `npm run zip:firefox`, then `about:debugging` → This Firefox → Load Temporary Add-on → `build/firefox/manifest.json`.

In Chrome and Edge a copy loaded this way has another extension id, so Google refuses its sign-in for the Drive backup.

## What leaves the browser

Dials, thumbnails and settings are kept in the browser's own storage (`store.js`). There are no ads, analytics or tracking. The code talks to nexuscortex.dev, to Google (only for the Drive backup) and, in Firefox, to your dials' own sites for their icons; `grep -rn "https://" src/*.js` lists every address.

Without you turning anything on:

| What | Where it goes | Code |
|---|---|---|
| Sync (on unless you turn it off) | The dial list (addresses, titles, groups, folders) goes into the browser's own sync storage for extensions. It never reaches nexuscortex.dev. | `sync.js` |
| Site icons, in Firefox only | Firefox lends extensions no icon cache, so each dial's site is asked for its `/favicon.ico`. Chrome and Edge use the browser's cache and ask nobody. | `newtab.js` |
| Removing Tabdial | The browser opens a feedback page; its address carries the version number and nothing else. | `background.js` |

Only if you use it:

| What | Where it goes | Code |
|---|---|---|
| Sync code (between browsers) | The dial list, thumbnails and site icons go to nexuscortex.dev, encrypted with a key made from the code, which never leaves the browser. | `sync.js` |
| Teams | A team's groups, their pictures, its name and its members' names go to nexuscortex.dev, encrypted with a key that travels in the invite link's `#` part, which browsers never send to a site. | `team.js` |
| Google Drive backup | One file in your own Google Drive, between the browser and Google. The `drive.file` scope reaches only files Tabdial made. | `drive.js` |
| Sort (comes with the unlock) | When you click Continue: the hostnames and titles of the dials in the group being sorted, and your other groups' names with a few of their hostnames, go to nexuscortex.dev, which passes them to an AI service (TypeSafe). | `sort.js` |
| The unlock | A random purchase id, a license key or, if you unlock by signing in with Google, a Google ID token goes to nexuscortex.dev. The payment itself is on Stripe. | `pay.js` |
| Jump with browsing history | Read on your computer; it goes nowhere. | `jump.js` |

The [privacy policy](https://nexuscortex.dev/tabdial/privacy/) says what the site keeps of each.

## What is not here

The server side of nexuscortex.dev (sync codes, teams, Sort, purchases) is not in this repository. What it receives is what the code here sends.

## License

Copyright © 2026 NEXUSCORTEX LLC.

The code is free software under the [GNU General Public License, version 3](LICENSE).

Two things are not covered by it:

- **The name and icon.** "Tabdial" and its icon stand for this project's own releases. A changed version must be published under another name and icon.
- **The background photos** in `src/photos/` come from Unsplash under the [Unsplash License](https://unsplash.com/license): [lake](https://unsplash.com/photos/oMneOBYhJxY) by John Lee, [sea](https://unsplash.com/photos/6ArTTluciuA) by Matt Hardy, [fog](https://unsplash.com/photos/KT3WlrL_bsg) by Paul Pastourmatzis, [sunset](https://unsplash.com/photos/twukN12EN7c) by simon, [forest](https://unsplash.com/photos/OYFHT4X5isg) by Dan Otis, [dunes](https://unsplash.com/photos/a2kD4b0KK4s) by Mike Iukhtenko, [aurora](https://unsplash.com/photos/62V7ntlKgL8) by Vincent Guth, [stars](https://unsplash.com/photos/phIFdC6lA4E) by Benjamin Voros.

## Questions

Open an issue, or write to support@nexuscortex.dev.

---

## 中文

Tabdial 是 Chrome、Edge、Firefox 的新标签页扩展：把常用网站排成带缩略图的网格，可以分组、建文件夹。

**这里有什么。** `src/` 就是上传到商店的扩展本身：普通的 JavaScript，没有构建步骤，没有压缩混淆，没有第三方库。每个上架的版本在这里有一个标签（如 `v0.4.1`），两个版本之间改了什么，对比两个标签就能看到。

**怎么核对商店里的包。** 把浏览器装好的包解开，和同版本的标签对比：

- Chrome、Edge：包就是 `src/`，商店会加一个 `_metadata/` 文件夹，并在 `manifest.json` 里加它自己的几行（Edge 是 `update_url`）。
- Firefox：包是 `npm run zip:firefox` 的产物，即 `src/` 加上 `manifest.json` 里为 Firefox 改的几行（脚本在 `package.json` 里）；Mozilla 会加一个 `META-INF/` 文件夹。

其余文件逐字节相同。

**什么会离开浏览器。** 网站、缩略图和设置都存在浏览器自己的存储里，没有广告、统计或跟踪。

- 不用你打开就会发生的：
  - 同步（默认开，可在设置里关）：网站列表存进浏览器自带的扩展同步存储，不经过 nexuscortex.dev。
  - Firefox 里向每个网站要它的 `/favicon.ico`（Chrome、Edge 用浏览器的缓存，不发请求）。
  - 卸载时浏览器打开一个反馈页，地址里只带版本号。
- 你用了才会发生的：
  - 同步码：列表、缩略图和网站图标加密后存到 nexuscortex.dev，密钥由同步码在浏览器里算出，不离开浏览器。
  - 团队：团队的分组、图片、名称和成员名加密后存到 nexuscortex.dev，密钥在邀请链接的 `#` 后面，浏览器不会把这部分发给网站。
  - Google Drive 备份：存到你自己的 Drive，只在浏览器和 Google 之间。
  - Sort（付费解锁）：点“继续”时，把要整理的那个分组里网站的域名和标题、其他分组的名称和几个域名，经 nexuscortex.dev 交给一个 AI 服务（TypeSafe）。
  - 解锁：一个随机的购买号、许可密钥，或用 Google 登录解锁时的 Google ID token，发给 nexuscortex.dev；付款在 Stripe 上完成。
  - Jump 读浏览记录：只在本机读，不发出去。

网站对每一项保留什么，见[隐私政策](https://nexuscortex.dev/tabdial/zh-cn/privacy/)。

**这里没有什么。** nexuscortex.dev 的服务端（同步码、团队、Sort、购买）不在这个仓库里。它能收到的，就是这里的代码发出去的。

**许可。** 版权归 NEXUSCORTEX LLC 所有，代码以 [GPL-3.0](LICENSE) 发布。有两样不在其内：“Tabdial”这个名字和图标（改过的版本请换名字和图标再发布）；`src/photos/` 里的背景照片来自 Unsplash，适用 [Unsplash License](https://unsplash.com/license)，作者见上面的英文部分。
