// Firebase の接続先（英文アプリ専用のプロジェクト majianki）。空のままならクラウド同期は使われず、記録は端末内だけに保存される。
// Firebase コンソール → プロジェクトの設定 →「マイアプリ」の firebaseConfig から写す。
// （これらは公開されてよい値。データを守るのはセキュリティルールと「家族の合言葉」）
export const CLOUD = {
  projectId: 'majianki',
  apiKey: 'AIzaSyDDxbMqK-yffumarHCvuVSU_hhHba_1RyA',
};
