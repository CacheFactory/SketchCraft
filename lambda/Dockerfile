# Lambda container image for SKP-to-OBJ conversion.
# Uses Wine to run Windows SketchUp SDK (SketchUpAPI.dll) on Linux.
#
# Build: docker build -t skp-convert-lambda .
# Test:  docker run -p 9000:8080 skp-convert-lambda
#        curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" \
#          -d '{"body": "{\"file\": \"<base64-skp>\", \"filename\": \"test.skp\"}"}'

FROM public.ecr.aws/lambda/python:3.12

# Install Wine from Amazon Linux extras / RPM
RUN dnf install -y \
    wget \
    cabextract \
    xorg-x11-server-Xvfb \
    && dnf clean all

# Install Wine from WineHQ or build from source
# Using Wine from Fedora COPR for Amazon Linux 2023 compatibility
RUN dnf install -y \
    https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm \
    && dnf install -y wine wine-core wine-common \
    || true

# If Wine isn't available from repos, use a pre-built static Wine
# Fallback: download a portable Wine build
RUN if ! command -v wine64 &> /dev/null; then \
    echo "Wine not found in repos, installing portable Wine..." && \
    mkdir -p /opt/wine && \
    wget -q "https://github.com/AdelKS/LinuxPortableWine/releases/download/v10.0/wine-v10.0-x86_64.tar.xz" \
      -O /tmp/wine.tar.xz && \
    tar -xf /tmp/wine.tar.xz -C /opt/wine --strip-components=1 && \
    rm /tmp/wine.tar.xz && \
    ln -sf /opt/wine/bin/wine64 /usr/local/bin/wine64 && \
    ln -sf /opt/wine/bin/winepath /usr/local/bin/winepath; \
    fi

# Create Wine prefix (headless — no display needed)
ENV WINEPREFIX=/tmp/wine
ENV WINEDEBUG=-all
ENV DISPLAY=:99

# Copy skp2obj Windows binary and SketchUp SDK DLLs
COPY skp2obj_win.exe /opt/skp2obj/skp2obj_win.exe
COPY sdk/ /opt/skp2obj/

# Ensure DLLs are on the Wine path
RUN mkdir -p /tmp/wine/drive_c/skp2obj && \
    cp /opt/skp2obj/*.dll /tmp/wine/drive_c/skp2obj/ 2>/dev/null || true && \
    cp /opt/skp2obj/*.exe /tmp/wine/drive_c/skp2obj/ 2>/dev/null || true

# Copy handler
COPY handler.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.lambda_handler"]
