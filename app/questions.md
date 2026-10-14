# Ignis integration questions

## 1. Ignis source

This workspace contains Obsidian Git only. Is your Ignis checkout elsewhere,
or should I obtain `Nystik-gh/ignis`? Which branch or commit matches your
deployment, and where should the server changes be delivered?

**Answer:**
Ignis can be found in `./ignis` folder. It is a platform that allows to run Obsidian as a web application on a server. Use Ignis as a reference only. We work to extend Obsidian Git for it to work with Ignis. All the changes must be outside of `./ignis` folder.

## 2. Authentication

How do users authenticate to Ignis today—an Ignis session, reverse-proxy
login, VPN-only access, or something else? Can different users access
different vaults?

**Answer:**
Ignis is a platform to self host Obsidian as a web application. It is not a multi-user platform. No need to think about authentication.


## 3. Deployment

Do you have an existing Docker Compose configuration to target? Please
provide its location or a redacted version, including vault mounts,
`PUID`/`PGID`, and SSH mount paths.

**Answer:**
Ignis with Obisidian Git is deployed on my server. Once the tasks in `./TASK.md` are completed, I will deploy it on my server. No need to provide a Docker Compose configuration.


## 4. Browser verification

Is a running Ignis instance available for testing plugin loading,
pulled-file visibility, and preservation of unsaved edits?

**Answer:**
Not at the moment. We are trying to setup a pilot extension of Obsidian Git to check if it is worth to continue.

## 5. Report filename collision

If `git_conflict.md` already belongs to the user or is tracked, may the
integration create a uniquely named alternative and link it in the notice?
The requirements mandate a report while prohibiting overwriting that file.

**Answer:**
Don't worry about it at this stage of the development. We will handle it later if needed.

