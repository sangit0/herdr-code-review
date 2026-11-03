# Publishing and updates

This project is published at https://github.com/sangit0/herdr-code-review.

## Publish an update

From the repository directory, run `npm test` and `herdr-app check mods/tabbed-changes`, then try the changed workflow in a running Herdr app. Review staged files, commit, and push `main` to `origin`.

Keep the repository public and keep its `herdr-mod` topic. Herdr's discovery requirements are `mods/<name>/`, `RECIPE.md`, and `preview.png`, without a `layouts/` directory in the shared mod package. The website says community discovery runs within an hour; listing and image screening are controlled by Herdr.

The existing screenshots show the Source Control views. Retake the preview when showcasing the new inline comments, using a disposable repository without private content.

## Rename without disrupting installed mods

The public product name and GitHub repository name can change independently of the internal mod ID. Keep `mods/tabbed-changes/`, layout references, asset paths, and the `tabbed-changes.*` shared-state keys unchanged so current installations and saved comments continue working.

GitHub redirects old repository URLs after a rename. Update the local `origin` to the new URL, and do not create another repository under the old name if you want those redirects to keep working. Herdr does not document whether old mod-listing URLs redirect; allow its index to refresh and verify the new listing.

References: [Herdr mod publishing](https://herdr.dev/mods/), [GitHub repository renaming](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).
