{
  "targets": [
    {
      "target_name": "openchamber_shell",
      "sources": ["windows-shell.cpp"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "libraries": ["shell32.lib", "ole32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++20", "/utf-8"]
        }
      }
    }
  ]
}
