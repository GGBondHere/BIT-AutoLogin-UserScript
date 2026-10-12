# BIT-AutoLogin-UserScript

<p align="center">
  <a href="https://github.com/GGBondHere"><img alt="作者" src="https://img.shields.io/badge/author-GGBondHere-blue.svg"></a>
  <img alt="版本" src="https://img.shields.io/badge/version-2.0.1-brightgreen.svg">
  <a href="https://github.com/GGBondHere/BIT-AutoLogin-UserScript/blob/main/LICENSE"><img alt="许可证" src="https://img.shields.io/badge/license-MIT-lightgrey.svg"></a>
</p>

---

一个为北京理工大学（BIT）网站登录设计的脚本，旨在提供无缝的自动登录体验和便捷的跨站点凭据管理。

<small>_注：测试环境为 Win11 Edge 浏览器 Tampermonkey。_</small>

---

## ✨ 主要功能

- **全自动登录**: 在访问北理工统一认证平台 (`sso.bit.edu.cn`) 或 `webvpn` 登录页时，自动填充已保存的学号和密码，并执行登录操作。
- **便捷菜单管理**: 在任意北理官网页面 (`*.bit.edu.cn`)，均可通过浏览器右上角的油猴插件图标唤出一个现代化、美观的自定义菜单，方便地管理你的登录信息。
- **安全凭据存储**: 你的密码将经过 `学号+密钥` 的专属 `XOR` 异或加密和 `Base64` 编码后，再存入浏览器本地。这能有效防止非技术人员直接窥探到你的明文密码，在便利和安全之间取得了良好平衡。
- **智能错误诊断**: 如果自动登录后检测到“密码错误”的提示，脚本会暂停当前页面并提醒你检查已保存的凭据，避免连续重复提交。图形验证码填好后可点击 `立即登录`，短信验证码仍在学校页面完成。
- **精准元素定位**: 通过精确的 `id` 和属性选择器定位页面元素，确保脚本在页面结构变化时依然能稳定运行，高效且可靠。

## 🚀 安装步骤

1.  **安装用户脚本管理器**
    首先，你的浏览器需要一个用户脚本管理器扩展。最常用的是 **Tampermonkey** (篡改猴)。请根据你的浏览器选择安装：

    - [Chrome 用户](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
    - [Firefox 用户](https://addons.mozilla.org/firefox/addon/tampermonkey/)
    - [Edge 用户](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2.  **安装本脚本**
    点击下面的链接，你的 Tampermonkey 扩展会自动弹出安装页面，点击“安装”即可。

    ➡️ **[点击此处安装 BIT-AutoLogin 脚本](https://raw.githubusercontent.com/GGBondHere/BIT-AutoLogin-UserScript/main/BIT-AutoLogin.user.js)** ⬅️

## 📖 使用指南

1.  **首次使用**
    安装脚本后，首次访问北理登录页，脚本会自动弹出一个窗口，提示你输入学号和密码。保存设置不会立即提交，可在登录页点击 `立即登录`。

2.  **访问管理菜单**
    在任意北理网站 (`*.bit.edu.cn`)，点击浏览器右上角的 Tampermonkey 扩展图标，在弹出的菜单中会看到 `BIT 自动登录菜单` 这一项，点击即可打开管理菜单。

3.  **菜单功能**
    - **⚙️ 修改/设置登录凭据**: 随时更新你保存的学号和密码。
    - **⚙️ 调整登录行为**: 设置是否自动提交，以及是否显示登录页状态卡片。
    - **🗑️ 清除已存登录凭据**: 一键删除所有已保存的信息。

## 📄 许可证

本项目采用 [MIT](LICENSE) 许可证。
