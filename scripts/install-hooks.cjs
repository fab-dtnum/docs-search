// Active les hooks git du projet (.githooks/pre-commit : gitleaks).
// Sans effet hors d'un dépôt git (image Docker, archive), pour ne pas faire
// échouer l'installation.
const { execFileSync } = require("node:child_process");

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
} catch {
  process.exit(0);
}
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
