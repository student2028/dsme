const { app, WebContentsView } = require('electron');
app.whenReady().then(() => {
  const v = new WebContentsView();
  console.log('before destroy:', !!v.webContents);
  v.webContents.destroy();
  console.log('after destroy:', !!v.webContents, v.webContents === undefined);
  app.quit();
});
