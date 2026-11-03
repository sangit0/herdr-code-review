# Publishing checklist

1. **Screenshots**: `preview.png` at the repo root and the rest in `docs/screenshots/` are already in place (taken on a throwaway repo). Retake any that show anything you don't want public.
2. **Licence**: `LICENSE` names the copyright holder; change it if it should be someone else. Publishing personal open source from a work machine or account may need your employer's approval; check your company's policy.
3. **Create the repo and push** from the `herdr-tabbed-changes` directory. Sign in with `gh auth login` first if needed. The command below makes the repository **public**; use `--private` if you prefer:
   ```sh
   gh repo create herdr-tabbed-changes --public --source . --push --description "VS Code-style Source Control for Herdr: diffs, multibuffer, file tabs and Neovim, all in tabs"
   gh repo edit --add-topic herdr-mod
   ```
4. herdr.dev lists repos with the `herdr-mod` topic within the hour (needs `RECIPE.md` and `preview.png`, both here).
5. Sanity: `npm test`, and `herdr-app check mods/tabbed-changes` on a clean Herdr home.
