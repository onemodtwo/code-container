import path from "path";
import { Filesystem } from "./platform/fs";
import {
  APPDATA_DIR,
  CONFIGS_DIR,
  TEMP_DIR,
  USER_DOCKERFILE_PATH,
  PROJECTS_DIR,
  CONTAINER_BASHRC_PATH,
} from "./platform/paths";
import { ensureHostConfig } from "./mount-config";

export const USER_DOCKERFILE_TEMPLATE = `# User customizations for container
# Add your RUN, ENV, COPY, etc. directives below.
FROM localhost/onemodtwo/code-container:latest
LABEL onemodtwo.code-container=v3
`;

export function runSetup(fs: Filesystem): void {
  fs.secureMkdir(APPDATA_DIR);
  fs.secureMkdir(CONFIGS_DIR);
  fs.secureMkdir(TEMP_DIR);
  fs.secureMkdir(PROJECTS_DIR);

  ensureHostConfig();

  if (!fs.existsSync(USER_DOCKERFILE_PATH)) {
    fs.secureWriteFile(USER_DOCKERFILE_PATH, USER_DOCKERFILE_TEMPLATE);
  }

  if (!fs.existsSync(CONTAINER_BASHRC_PATH)) {
    const packagedBashrc = path.resolve(__dirname, "..", "container.bashrc");
    if (fs.existsSync(packagedBashrc)) {
      fs.cpSync(packagedBashrc, CONTAINER_BASHRC_PATH);
    }
  }
}
