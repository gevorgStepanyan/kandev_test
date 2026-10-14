fetch(
    "/api/ext/obsidian-git/pull",
    {
        method: "POST",
        headers: {
            "X-Obsidian-Git": "1",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ vaultId: window.__currentVaultId }),
        cache: "no-store",
    }
)
    .then(async (response) => {
        console.log("HTTP", response.status, await response.json());
    })
    .catch(console.error);
