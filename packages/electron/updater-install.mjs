const normalizeUpdateLocale = (value) => {
  const normalized = String(value || '').toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh-tw' || normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-TW';
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('fr')) return 'fr';
  if (normalized.startsWith('uk') || normalized.startsWith('ua')) return 'uk';
  if (normalized.startsWith('es')) return 'es';
  if (normalized === 'pt' || normalized.startsWith('pt-br')) return 'pt-BR';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('pl')) return 'pl';
  if (normalized.startsWith('ja')) return 'ja';
  return 'en';
};

const UPDATE_FAILURE_COPY = {
  en: { title: 'OpenChamber update failed', detail: 'Background services have stopped. Restart the current version to continue.', restart: 'Restart' },
  fr: { title: 'La mise à jour d’OpenChamber a échoué', detail: 'Les services en arrière-plan sont arrêtés. Redémarrez la version actuelle pour continuer.', restart: 'Redémarrer' },
  'zh-CN': { title: 'OpenChamber 更新失败', detail: '后台服务已停止。请重启当前版本以继续使用。', restart: '重启' },
  'zh-TW': { title: 'OpenChamber 更新失敗', detail: '背景服務已停止。請重新啟動目前版本以繼續使用。', restart: '重新啟動' },
  uk: { title: 'Не вдалося оновити OpenChamber', detail: 'Фонові служби зупинено. Перезапустіть поточну версію, щоб продовжити.', restart: 'Перезапустити' },
  es: { title: 'La actualización de OpenChamber falló', detail: 'Los servicios en segundo plano se han detenido. Reinicia la versión actual para continuar.', restart: 'Reiniciar' },
  'pt-BR': { title: 'Falha ao atualizar o OpenChamber', detail: 'Os serviços em segundo plano foram encerrados. Reinicie a versão atual para continuar.', restart: 'Reiniciar' },
  ko: { title: 'OpenChamber 업데이트 실패', detail: '백그라운드 서비스가 중지되었습니다. 계속하려면 현재 버전을 다시 시작하세요.', restart: '다시 시작' },
  pl: { title: 'Aktualizacja OpenChamber nie powiodła się', detail: 'Usługi w tle zostały zatrzymane. Uruchom ponownie bieżącą wersję, aby kontynuować.', restart: 'Uruchom ponownie' },
  ja: { title: 'OpenChamber の更新に失敗しました', detail: 'バックグラウンドサービスは停止しています。続行するには現在のバージョンを再起動してください。', restart: '再起動' },
  de: { title: 'OpenChamber-Update fehlgeschlagen', detail: 'Die Hintergrunddienste wurden beendet. Starten Sie die aktuelle Version neu, um fortzufahren.', restart: 'Neu starten' },
  tr: { title: 'OpenChamber güncellenemedi', detail: 'Arka plan hizmetleri durduruldu. Devam etmek için mevcut sürümü yeniden başlatın.', restart: 'Yeniden başlat' },
};

export const getUpdateFailureDialogCopy = (locale) => {
  const language = String(locale || '').toLowerCase().split('-')[0];
  return UPDATE_FAILURE_COPY[language === 'de' || language === 'tr' ? language : normalizeUpdateLocale(locale)];
};

// Cleanup and the platform installer share one exit owner. A stopped backend
// cannot be rolled back by clearing flags; failure recovers in a fresh process.
export const createUpdateInstaller = ({ state, autoUpdater, shutdown, showFailure, restart, log, shutdownTimeoutMs = 40_000, installGraceMs = 15_000 }) => {
  let installation;
  return () => {
    if (installation) return installation;
    state.updateInstallPending = true;
    state.quitInProgress = true;
    installation = new Promise((resolve, reject) => {
      let settled = false;
      let graceTimer;
      const stopped = new Promise((ready) => setImmediate(ready)).then(async () => {
        let timer;
        try {
          await Promise.race([
            shutdown(),
            new Promise((done) => {
              timer = setTimeout(() => {
                log.warn('[electron] background shutdown timed out before update install; continuing');
                done();
              }, shutdownTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        autoUpdater.off('error', fail);
        state.updateInstallPending = false;
        state.installingUpdate = false;
        state.quitRequested = false;
        state.allowWindowClose = false;
        log.error('[electron] update install failed', error);
        reject(error instanceof Error ? error : new Error(String(error)));
        void stopped.catch(() => {}).then(showFailure)
          .catch((failure) => log.warn('[electron] failed to show update error', failure))
          .then(() => {
            state.allowWindowClose = true;
            restart();
          });
      };
      autoUpdater.on('error', fail);
      void stopped.then(() => {
        if (settled) return;
        graceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          autoUpdater.off('error', fail);
          resolve(null);
        }, installGraceMs);
        state.quitRequested = true;
        state.installingUpdate = true;
        state.quitConfirmationPending = false;
        state.allowWindowClose = true;
        log.info('[electron] handing control to the platform installer');
        autoUpdater.quitAndInstall();
        state.updateInstallPending = false;
      }).catch(fail);
    });
    return installation;
  };
};
