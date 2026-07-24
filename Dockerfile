FROM ubuntu:24.04
LABEL onemodtwo.code-container=v3
WORKDIR /root
CMD ["/bin/bash"]

RUN rm -rf /home/user && ln -s /root /home/user

RUN echo 'source /etc/container.bashrc' > /root/.bashrc

ENV TZ=America/New_York
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    curl \
    wget \
    unzip \
    ca-certificates \
    libssl-dev \
    zlib1g-dev \
    libffi-dev \
    vim \
    tree

ENV NVM_DIR=/root/.nvm
ENV NODE_VERSION=22
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install ${NODE_VERSION} \
    && nvm use ${NODE_VERSION} \
    && nvm alias default ${NODE_VERSION} \
    && ln -sf "$NVM_DIR/versions/node/$(nvm current)/bin/"* /usr/local/bin/

# ── Tools ──────────────────────────────────────────────────────────
ARG INSTALL_PYTHON=false
ARG INSTALL_BUN=false
ARG INSTALL_ENHANCED_TOOLS=false
ARG INSTALL_DENO=false
ARG INSTALL_RUST=false
ARG INSTALL_GO=false
ARG INSTALL_UV=false
ARG INSTALL_GH=false
ARG INSTALL_AWS=false
ARG INSTALL_GCLOUD=false
ARG INSTALL_AZURE=false
ARG INSTALL_NEOVIM=false

RUN if [ "$INSTALL_PYTHON" = "true" ]; then \
      apt-get update && apt-get install -y python3 python3-dev python3-venv python3-pip \
      && ln -sf /usr/bin/python3 /usr/bin/python; \
    fi

RUN if [ "$INSTALL_BUN" = "true" ]; then \
      BUN_INSTALL="$HOME/.bun" curl -fsSL https://bun.sh/install | bash; \
      echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc; \
    fi

RUN if [ "$INSTALL_ENHANCED_TOOLS" = "true" ]; then \
      apt-get update && apt-get install -y fd-find bat fzf ripgrep eza git-lfs jq \
      && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
      && ln -sf /usr/bin/batcat /usr/local/bin/bat; \
    fi

RUN if [ "$INSTALL_DENO" = "true" ]; then \
      curl -fsSL https://deno.land/install.sh | sh \
      && echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.bashrc; \
    fi

RUN if [ "$INSTALL_RUST" = "true" ]; then \
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
      && echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc; \
    fi

RUN if [ "$INSTALL_GO" = "true" ]; then \
      apt-get update && apt-get install -y golang; \
    fi

RUN if [ "$INSTALL_UV" = "true" ]; then \
      INSTALLER_NO_MODIFY_PROFILE=1 curl -LsSf https://astral.sh/uv/install.sh | sh; \
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc; \
    fi

RUN if [ "$INSTALL_GH" = "true" ]; then \
      apt-get update && apt-get install -y gh; \
    fi

RUN if [ "$INSTALL_AWS" = "true" ]; then \
      ARCH=$(uname -m) \
      && if [ "$ARCH" = "aarch64" ]; then AWS_ARCH="aarch64"; else AWS_ARCH="x86_64"; fi \
      && curl "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o "awscliv2.zip" \
      && unzip awscliv2.zip && ./aws/install && rm -rf aws awscliv2.zip; \
    fi

RUN if [ "$INSTALL_GCLOUD" = "true" ]; then \
      ARCH=$(uname -m) \
      && if [ "$ARCH" = "aarch64" ]; then GCLOUD_ARCH="arm"; else GCLOUD_ARCH="x86_64"; fi \
      && curl -O "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-${GCLOUD_ARCH}.tar.gz" \
      && tar -xf "google-cloud-cli-linux-${GCLOUD_ARCH}.tar.gz" \
      && ./google-cloud-sdk/install.sh --quiet \
      && rm "google-cloud-cli-linux-${GCLOUD_ARCH}.tar.gz" \
      && echo 'export PATH="/root/google-cloud-sdk/bin:$PATH"' >> ~/.bashrc; \
    fi

RUN if [ "$INSTALL_AZURE" = "true" ]; then \
      curl -sL https://aka.ms/InstallAzureCLIDeb | bash; \
    fi

RUN if [ "$INSTALL_NEOVIM" = "true" ]; then \
      apt-get update && apt-get install -y neovim; \
    fi

# ── Harnesses ──────────────────────────────────────────────────────
ARG INSTALL_CLAUDE=false
ARG INSTALL_OPENCODE=false
ARG INSTALL_CODEX=false
ARG INSTALL_PI=false
ARG INSTALL_GEMINI=false
ARG INSTALL_COPILOT=false
ARG INSTALL_GROK=false
ARG INSTALL_CURSOR=false
ARG INSTALL_NITRO=false
ARG INSTALL_ANTIGRAVITY=false

RUN if [ "$INSTALL_CLAUDE" = "true" ]; then \
      curl -fsSL https://claude.ai/install.sh | bash \
      && echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc; \
    fi

RUN if [ "$INSTALL_OPENCODE" = "true" ]; then \
      npm install -g opencode-ai; \
    fi

RUN if [ "$INSTALL_CODEX" = "true" ]; then \
      npm install -g @openai/codex; \
    fi

RUN if [ "$INSTALL_PI" = "true" ]; then \
      npm install -g @earendil-works/pi-coding-agent; \
    fi

RUN if [ "$INSTALL_GEMINI" = "true" ]; then \
      npm install -g @google/gemini-cli; \
    fi

RUN if [ "$INSTALL_COPILOT" = "true" ]; then \
      npm install -g @github/copilot; \
    fi

RUN if [ "$INSTALL_GROK" = "true" ]; then \
      curl -fsSL https://x.ai/cli/install.sh | bash \
      && echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc; \
    fi

RUN if [ "$INSTALL_CURSOR" = "true" ]; then \
      curl https://cursor.com/install -fsS | bash; \
    fi

RUN if [ "$INSTALL_NITRO" = "true" ]; then \
      npm install -g @aerovato/nitro; \
    fi

RUN if [ "$INSTALL_ANTIGRAVITY" = "true" ]; then \
      curl -fsSL https://antigravity.google/cli/install.sh | bash \
      && echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc; \
    fi
