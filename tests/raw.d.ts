// Vite's `?raw` import, used so fixtures can be loaded inside the Workers pool
// where `node:fs` does not exist.
declare module "*?raw" {
  const content: string;
  export default content;
}
