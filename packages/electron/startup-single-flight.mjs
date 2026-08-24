export const createStartupSingleFlight = (start) => {
  let startupPromise;
  return () => {
    if (startupPromise !== undefined) return startupPromise;
    try {
      startupPromise = Promise.resolve(start());
    } catch (error) {
      startupPromise = Promise.reject(error);
    }
    return startupPromise;
  };
};
