# Git Setup Guide for QuantCalendar

## Step-by-Step Instructions

### Step 1: Initialize Git Repository
```bash
cd /Users/henrylai/Documents/QuantCalendar
git init
```
This creates a new git repository in your project folder.

### Step 2: Check What Files Will Be Tracked
```bash
git status
```
This shows you which files are new, modified, or already tracked.

### Step 3: Add All Files to Staging
```bash
git add .
```
This stages all your files (except those in `.gitignore`) to be committed.

### Step 4: Make Your First Commit
```bash
git commit -m "Initial commit: QuantCalendar project"
```
This creates your first commit with a descriptive message.

### Step 5: Create a GitHub Repository
1. Go to https://github.com and sign in
2. Click the "+" icon in the top right → "New repository"
3. Name it (e.g., "QuantCalendar")
4. **Don't** initialize with README, .gitignore, or license (since you already have files)
5. Click "Create repository"

### Step 6: Connect Your Local Repo to GitHub
After creating the repo, GitHub will show you commands. Use these (replace `YOUR_USERNAME` with your GitHub username):

**If using HTTPS:**
```bash
git remote add origin https://github.com/YOUR_USERNAME/QuantCalendar.git
git branch -M main
git push -u origin main
```

**If using SSH:**
```bash
git remote add origin git@github.com:YOUR_USERNAME/QuantCalendar.git
git branch -M main
git push -u origin main
```

## Quick Reference Commands

- `git status` - Check what files have changed
- `git add .` - Stage all changes
- `git add <filename>` - Stage a specific file
- `git commit -m "message"` - Save changes with a message
- `git log` - View your commit history
- `git push` - Upload your commits to GitHub
- `git pull` - Download latest changes from GitHub

## Common Workflow

```bash
# 1. Make changes to your files
# 2. Check what changed
git status

# 3. Add the changes
git add .

# 4. Commit with a descriptive message
git commit -m "Description of what you changed"

# 5. Push to GitHub
git push
```

## Troubleshooting

- **If you get authentication errors**: You may need to set up a Personal Access Token (PAT) for HTTPS or SSH keys for SSH
- **If files aren't being ignored**: Check your `.gitignore` file
- **If you want to undo a commit**: `git reset --soft HEAD~1` (keeps your changes)
