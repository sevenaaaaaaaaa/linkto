{
  "targets": [
    {
      "target_name": "linkto_shell",
      "sources": ["shell.mm"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc", "-std=c++17"],
            "OTHER_LDFLAGS": ["-framework", "AppKit", "-framework", "Foundation"]
          }
        }]
      ]
    }
  ]
}
