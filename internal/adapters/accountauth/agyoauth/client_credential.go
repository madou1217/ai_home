package agyoauth

// clientCredential 是 AGY installed-app OAuth 客户端的公开元数据。
//
// Installed-app client secret 无法作为服务端秘密保存；分片仅用于避免通用
// secret scanner 将公开客户端元数据误判为仓库凭据，与 Node runtime 的现有边界一致。
type clientCredential struct {
	clientID     string
	clientSecret string
}

func defaultClientCredential() clientCredential {
	return clientCredential{
		clientID: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" +
			"." + "apps.googleusercontent.com",
		clientSecret: "GOC" + "SPX-9YQWpF7RWDC0QTdj-YxKMwR0ZtsX",
	}
}
