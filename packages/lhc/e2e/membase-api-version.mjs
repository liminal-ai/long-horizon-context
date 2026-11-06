Bun.plugin({
  name: "membase-api-version",
  setup(build) {
    build.onLoad({ filter: /packages\/contract\/src\/index\.ts$/ }, async ({ path }) => ({
      contents: (await Bun.file(path).text()).replace(
        /MEMBASE_API_VERSION = \d+/,
        `MEMBASE_API_VERSION = ${process.env.MEMBASE_FAKE_API_VERSION}`,
      ),
      loader: "ts",
    }));
  },
});
