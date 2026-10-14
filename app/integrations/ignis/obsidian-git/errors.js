class GitServiceError extends Error {
    constructor(code, message, status = 409, reportFile) {
        super(message);
        this.code = code;
        this.status = status;
        this.reportFile = reportFile;
    }
}
function publicError(error) {
    if (error instanceof GitServiceError) return error;
    if (error?.code === "EACCES" || error?.code === "EPERM") {
        return new GitServiceError(
            "PERMISSION_DENIED",
            "Git cannot access the vault. Check server ownership and permissions.",
            403
        );
    }
    return new GitServiceError(
        "SERVER_ERROR",
        "The Git server operation failed. Check the server logs.",
        500
    );
}
module.exports = { GitServiceError, publicError };
