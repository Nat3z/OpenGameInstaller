---
layout: ../../../layouts/BlogLayout.astro
title: Publish your Addon
description: A guide on how to make your first addon for OpenGameInstaller.
part: 7
section: Your First Addon
---

Publishing your addon is incredibly simple. You must use a **git-based** repository site, like [GitHub](https://github.com) or [GitLab](https://gitlab.com).

Make **SURE** that you created a [.gitignore file](/docs/first-addon#Create%20a%20.gitignore%20file) before publishing.

Then, using **git**, initialize a git repo with:
```bash
$ git init
```

Next, connect your **remote repository** which is on GitHub or GitLab with:
```bash
$ git remote add origin REPO_URL_HERE
```

Then, run these next commands to push your code to the remote repository:
```bash
$ git add .
$ git commit -m "initial commit"
$ git push origin main
```

This will create a new branch on your remote repository called *main* where your addon will be stored.

**Congratulations!** You can now add the addon by grabbing the Git repository link and inserting it into the addons option in OpenGameInstaller!