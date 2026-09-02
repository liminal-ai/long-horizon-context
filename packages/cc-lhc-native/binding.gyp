{
  "targets": [
    {
      "target_name": "cc_lhc_identity",
      "sources": ["src/native/identity.c"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        [
          "OS=='linux'",
          {
            "cflags": ["-Wall", "-Wextra", "-Werror"]
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "MACOSX_DEPLOYMENT_TARGET": "11.0",
              "WARNING_CFLAGS": ["-Wall", "-Wextra", "-Werror"]
            }
          }
        ],
        [
          "OS=='win'",
          {
            "libraries": ["rstrtmgr.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "WarningLevel": "3",
                "WarnAsError": "true"
              }
            }
          }
        ]
      ]
    }
  ]
}
