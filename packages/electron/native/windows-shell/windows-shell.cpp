#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <winhttp.h>
#include <dwrite_1.h>
#include <wrl/client.h>
#include <napi.h>
#include <memory>
#include <string>
#include <stdexcept>
#include <vector>

struct ShellComApartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  ~ShellComApartment() {
    if (SUCCEEDED(result)) CoUninitialize();
  }
};

struct ShellItemDeleter {
  using pointer = PIDLIST_ABSOLUTE;
  void operator()(pointer item) const { ILFree(item); }
};

class OpenDirectoryWorker : public Napi::AsyncWorker {
public:
  OpenDirectoryWorker(Napi::Env env, std::wstring path)
      : Napi::AsyncWorker(env, "OpenChamber:openDirectory"), deferred(Napi::Promise::Deferred::New(env)), directory(std::move(path)) {}

  Napi::Promise Promise() { return deferred.Promise(); }

  void Execute() override {
    ShellComApartment apartment;
    if (FAILED(apartment.result)) {
      SetError("Failed to initialize shell COM apartment: " + std::to_string(static_cast<unsigned long>(apartment.result)));
      return;
    }

    const DWORD attributes = GetFileAttributesW(directory.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      Fail("Failed to access directory", GetLastError());
      return;
    }
    if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
      Fail("Path is not a directory", ERROR_DIRECTORY);
      return;
    }

    PIDLIST_ABSOLUTE parsed = nullptr;
    SFGAOF shellAttributes = 0;
    const HRESULT result = SHParseDisplayName(directory.c_str(), nullptr, &parsed, SFGAO_FOLDER | SFGAO_FILESYSTEM, &shellAttributes);
    std::unique_ptr<ITEMIDLIST, ShellItemDeleter> item(parsed);
    if (FAILED(result)) {
      SetError("Failed to resolve shell directory: " + std::to_string(static_cast<unsigned long>(result)));
      return;
    }
    if ((shellAttributes & (SFGAO_FOLDER | SFGAO_FILESYSTEM)) != (SFGAO_FOLDER | SFGAO_FILESYSTEM)) {
      Fail("Shell item is not a filesystem directory", ERROR_DIRECTORY);
      return;
    }

    SHELLEXECUTEINFOW info{};
    info.cbSize = sizeof(info);
    info.fMask = SEE_MASK_IDLIST | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpIDList = item.get();
    // A null verb honors the registered default, including DOpus's openindopus.
    // A PIDL identifies the directory without ShellExecute's executable-name guessing.
    info.lpVerb = nullptr;
    info.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&info)) Fail("Failed to open directory", GetLastError());
  }

  void OnOK() override { deferred.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& error) override { deferred.Reject(error.Value()); }

private:
  void Fail(const std::string& message, DWORD code) { SetError(message + ": Windows error " + std::to_string(code)); }

  Napi::Promise::Deferred deferred;
  std::wstring directory;
};

Napi::Value OpenDirectory(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  if (info.Length() != 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "openDirectory requires one directory path string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::u16string text = info[0].As<Napi::String>().Utf16Value();
  if (text.empty() || text.find(u'\0') != std::u16string::npos) {
    Napi::TypeError::New(env, "Directory path must be nonempty and contain no NUL characters").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto worker = std::make_unique<OpenDirectoryWorker>(env, std::wstring(text.begin(), text.end()));
  const auto promise = worker->Promise();
  worker->Queue();
  worker.release(); // AsyncWorker destroys itself after settling the promise.
  return promise;
}

std::u16string ReadRegistryPath(HKEY root, const wchar_t* key) {
  DWORD bytes = 0;
  const DWORD flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
  auto result = RegGetValueW(root, key, L"Path", flags, nullptr, nullptr, &bytes);
  if (result == ERROR_FILE_NOT_FOUND) return {};
  if (result != ERROR_SUCCESS) throw std::runtime_error("Failed to read registry PATH: Windows error " + std::to_string(result));
  std::vector<wchar_t> value(bytes / sizeof(wchar_t) + 1, L'\0');
  result = RegGetValueW(root, key, L"Path", flags, nullptr, value.data(), &bytes);
  if (result != ERROR_SUCCESS) throw std::runtime_error("Failed to read registry PATH: Windows error " + std::to_string(result));
  const std::wstring text(value.data());
  return std::u16string(text.begin(), text.end());
}

Napi::Value ReadEnvironmentPaths(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  try {
    auto paths = Napi::Object::New(env);
    paths.Set("machine", Napi::String::New(env, ReadRegistryPath(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")));
    paths.Set("user", Napi::String::New(env, ReadRegistryPath(HKEY_CURRENT_USER, L"Environment")));
    return paths;
  } catch (const std::exception& error) {
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

struct UserProxyConfig {
  WINHTTP_CURRENT_USER_IE_PROXY_CONFIG value{};
  ~UserProxyConfig() {
    GlobalFree(value.lpszAutoConfigUrl);
    GlobalFree(value.lpszProxy);
    GlobalFree(value.lpszProxyBypass);
  }
};

Napi::Value ReadSystemProxy(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  UserProxyConfig config;
  if (!WinHttpGetIEProxyConfigForCurrentUser(&config.value)) {
    Napi::Error::New(env, "Failed to read system proxy: Windows error " + std::to_string(GetLastError())).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto result = Napi::Object::New(env);
  const std::wstring server(config.value.lpszProxy ? config.value.lpszProxy : L"");
  const std::wstring bypass(config.value.lpszProxyBypass ? config.value.lpszProxyBypass : L"");
  result.Set("server", Napi::String::New(env, std::u16string(server.begin(), server.end())));
  result.Set("bypass", Napi::String::New(env, std::u16string(bypass.begin(), bypass.end())));
  return result;
}

void CheckFontResult(HRESULT result) {
  if (FAILED(result)) throw std::runtime_error("Failed to enumerate system fonts: HRESULT " + std::to_string(static_cast<unsigned long>(result)));
}

std::wstring ReadFontFamilyName(IDWriteLocalizedStrings* names, const wchar_t* locale) {
  UINT32 index = 0;
  BOOL exists = FALSE;
  CheckFontResult(names->FindLocaleName(locale, &index, &exists));
  if (!exists) index = 0;
  UINT32 length = 0;
  CheckFontResult(names->GetStringLength(index, &length));
  std::wstring name(length + 1, L'\0');
  CheckFontResult(names->GetString(index, name.data(), length + 1));
  name.resize(length);
  return name;
}

class ListMonospaceFontsWorker : public Napi::AsyncWorker {
public:
  explicit ListMonospaceFontsWorker(Napi::Env env)
      : Napi::AsyncWorker(env, "OpenChamber:listMonospaceFonts"), deferred(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise Promise() { return deferred.Promise(); }

  void Execute() override {
    try {
      Microsoft::WRL::ComPtr<IDWriteFactory> factory;
      CheckFontResult(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(factory.GetAddressOf())));
      Microsoft::WRL::ComPtr<IDWriteFontCollection> collection;
      CheckFontResult(factory->GetSystemFontCollection(collection.GetAddressOf(), TRUE));
      wchar_t locale[LOCALE_NAME_MAX_LENGTH] = L"en-US";
      if (!GetUserDefaultLocaleName(locale, LOCALE_NAME_MAX_LENGTH)) wcscpy_s(locale, L"en-US");
      for (UINT32 i = 0; i < collection->GetFontFamilyCount(); ++i) {
        Microsoft::WRL::ComPtr<IDWriteFontFamily> family;
        CheckFontResult(collection->GetFontFamily(i, family.GetAddressOf()));
        Microsoft::WRL::ComPtr<IDWriteFont> font;
        CheckFontResult(family->GetFirstMatchingFont(DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, font.GetAddressOf()));
        Microsoft::WRL::ComPtr<IDWriteFont1> font1;
        CheckFontResult(font.As(&font1));
        if (!font1->IsMonospacedFont()) continue;
        Microsoft::WRL::ComPtr<IDWriteLocalizedStrings> names;
        CheckFontResult(family->GetFamilyNames(names.GetAddressOf()));
        fonts.push_back({ ReadFontFamilyName(names.Get(), L"en-US"), ReadFontFamilyName(names.Get(), locale) });
      }
    } catch (const std::exception& error) {
      SetError(error.what());
    }
  }

  void OnOK() override {
    auto result = Napi::Array::New(Env(), fonts.size());
    for (size_t i = 0; i < fonts.size(); ++i) {
      auto entry = Napi::Object::New(Env());
      entry.Set("family", Napi::String::New(Env(), std::u16string(fonts[i].family.begin(), fonts[i].family.end())));
      entry.Set("label", Napi::String::New(Env(), std::u16string(fonts[i].label.begin(), fonts[i].label.end())));
      result.Set(static_cast<uint32_t>(i), entry);
    }
    deferred.Resolve(result);
  }

  void OnError(const Napi::Error& error) override { deferred.Reject(error.Value()); }

private:
  struct FontFamily { std::wstring family; std::wstring label; };
  Napi::Promise::Deferred deferred;
  std::vector<FontFamily> fonts;
};

Napi::Value ListMonospaceFonts(const Napi::CallbackInfo& info) {
  auto worker = std::make_unique<ListMonospaceFontsWorker>(info.Env());
  const auto promise = worker->Promise();
  worker->Queue();
  worker.release();
  return promise;
}

Napi::Object InitializeWindowsShell(Napi::Env env, Napi::Object exports) {
  exports.Set("listMonospaceFonts", Napi::Function::New(env, ListMonospaceFonts));
  exports.Set("openDirectory", Napi::Function::New(env, OpenDirectory));
  exports.Set("readEnvironmentPaths", Napi::Function::New(env, ReadEnvironmentPaths));
  exports.Set("readSystemProxy", Napi::Function::New(env, ReadSystemProxy));
  return exports;
}

NODE_API_MODULE(openchamber_shell, InitializeWindowsShell)
