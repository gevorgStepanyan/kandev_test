cp -i ~/obsidian/kandev_test/app/styles.css /mnt/ssd/obsidian/Main/.obsidian/plugins/obsidian-git/styles.css

cp -i ~/obsidian/kandev_test/app/manifest.json /mnt/ssd/obsidian/Main/.obsidian/plugins/obsidian-git/manifest.json 

cp -i ~/obsidian/kandev_test/app/main.js /mnt/ssd/obsidian/Main/.obsidian/plugins/obsidian-git/main.js

export GIT_SSH_COMMAND="ssh \
  -i /home/rpvaultuser/obsidian/.ssh/id_ed25519 \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile=/home/rpvaultuser/obsidian/.ssh/known_hosts \
  -o StrictHostKeyChecking=yes \
  -o BatchMode=yes"
