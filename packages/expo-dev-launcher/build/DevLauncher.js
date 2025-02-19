let errorHandlerWasRegistered = false;
const unavailableErrorPossibleSolutions = `Some possible solutions:
- Make sure that the method is available on the current platform.
- Make sure you're using the newest available version of this development client.
- Make sure you're running a compatible version of your JavaScript code.
- If you've installed a new library recently, you may need to make a new development client build.`;
const moduleIsMissingPossibleSolutions = `Some possible solutions:
- Make sure you're using the newest available version of this development client.
- Make sure you're running a compatible version of your JavaScript code.
- If you've installed a new library recently, you may need to make a new development client build.`;
function customizeUnavailableMessage(error) {
    error.message += '\n\n' + unavailableErrorPossibleSolutions;
}
function customizeModuleIsMissingMessage(error) {
    error.message = `Your JavaScript code tried to access a native module that doesn't exist in this development client. 

${moduleIsMissingPossibleSolutions}`;
}
function customizeError(error) {
    if ('code' in error) {
        // It's a CodedError from expo modules
        switch (error.code) {
            case 'ERR_UNAVAILABLE': {
                customizeUnavailableMessage(error);
                break;
            }
        }
    }
    else if (error.message.includes('Native module cannot be null')) {
        customizeModuleIsMissingMessage(error);
    }
}
function errorHandler(fn, error, isFatal) {
    if (error instanceof Error) {
        customizeError(error);
    }
    fn(error, isFatal);
}
export function registerErrorHandlers() {
    if (errorHandlerWasRegistered) {
        return;
    }
    errorHandlerWasRegistered = true;
    const globalHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler(function (...args) {
        errorHandler(globalHandler, ...args);
    });
}
//# sourceMappingURL=DevLauncher.js.map