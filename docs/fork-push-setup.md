# Fork 推送通知配置（happy-plus）

本 fork 的 APK 默认打包了一个**假的 `google-services.json` 桩文件**（合成的
`mobilesdk_app_id`），所以 FCM 注册会失败（`getExpoPushTokenAsync` 永久挂起，
App 端已用 8s 超时兜底，UI 不会卡死，但推送不可用）。要让推送真正工作，按
下面步骤配置一次即可。

## 步骤

### 1. Firebase Console — 拿真实的 google-services.json

1. 打开 [Firebase Console](https://console.firebase.google.com/)，新建项目（名字随意）。
2. 项目里「添加应用」→ Android，**包名填 `com.yiran.happyplus`**（即 `APP_ENV=plus` 的 applicationId）。
3. 下载生成的 `google-services.json`，保存好。

### 2. Firebase 服务账号私钥

1. Firebase 项目设置 → 「服务账号」标签页。
2. 点「生成新的私钥」，下载 JSON 文件（这是 FCM V1 凭证，给 Expo 用）。

### 3. expo.dev — 创建项目并上传 FCM 凭证

1. 在 [expo.dev](https://expo.dev/) 创建一个项目，记下 **projectId（UUID）**。
2. 项目 → Credentials → Android → FCM V1 service account key → 上传第 2 步的服务账号 JSON。

### 4. GitHub 仓库配置（yiranxiaohui/happy-plus → Settings）

- **Variables** 新增：`EAS_PROJECT_ID` = 第 3 步的 UUID
  （`app.config.js` 会用它覆盖上游硬编码的 projectId；为空则回退到上游 id，无害但推送不通）。
- **Secrets** 新增：`GOOGLE_SERVICES_JSON` = 第 1 步下载文件的**完整 JSON 内容**
  （android-apk workflow 在 prebuild 前会把它写入 `packages/happy-app/google-services.json` 替换桩文件；仅 `APP_ENV=plus` 时生效）。

### 5. 重新打包并验证

1. 打下一个 `v*` 或 `apk-v*` tag，等 APK 构建完成。
2. 安装新 APK → 账户（Account）→ Push Notifications → **Re-register This Device**。
3. 「Registered Tokens」里应出现一条 `ExponentPushToken[...]`，即配置成功。

### 6. 服务端

无需任何配置 —— happy-server 直接调用 Expo 公共推送 API（exp.host），
token 是 ExponentPushToken 形式，由 Expo 负责转发给 FCM。
