const { app, WebContentsView } = require('electron');
app.whenReady().then(() => {
  const v = new WebContentsView();
  try {
    v.webContents.loadURL('about:blank').catch(e => console.log('Promise catch:', e.message));
  } catch (e) {
    console.log('Sync catch:', e.message);
  }
  app.quit();
});
