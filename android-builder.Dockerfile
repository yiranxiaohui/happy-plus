FROM eclipse-temurin:17-jdk-jammy

ARG ANDROID_CMDLINE_VERSION=11076708
ARG ANDROID_PLATFORM=35
ARG ANDROID_BUILD_TOOLS=35.0.0
ARG ANDROID_NDK=26.1.10909125

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates unzip git xz-utils python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (Expo SDK 55 supports >=20; pick 22 LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Android SDK command-line tools
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
    && cd /tmp \
    && curl -fsSL -o cmdtools.zip "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_VERSION}_latest.zip" \
    && unzip -q cmdtools.zip -d $ANDROID_HOME/cmdline-tools \
    && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
    && rm cmdtools.zip

# Accept licenses + install platform + build-tools + NDK
RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager --install \
        "platform-tools" \
        "platforms;android-${ANDROID_PLATFORM}" \
        "build-tools;${ANDROID_BUILD_TOOLS}" \
        "ndk;${ANDROID_NDK}" \
    && echo "ANDROID_NDK_HOME=$ANDROID_HOME/ndk/${ANDROID_NDK}" >> /etc/environment

ENV ANDROID_NDK_HOME=/opt/android-sdk/ndk/26.1.10909125
ENV GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx4g"

WORKDIR /workspace
CMD ["bash"]
