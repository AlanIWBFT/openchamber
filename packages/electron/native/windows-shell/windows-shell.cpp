#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <napi.h>
#include <memory>
#include <string>

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

Napi::Object InitializeWindowsShell(Napi::Env env, Napi::Object exports) {
  exports.Set("openDirectory", Napi::Function::New(env, OpenDirectory));
  return exports;
}

NODE_API_MODULE(openchamber_shell, InitializeWindowsShell)
