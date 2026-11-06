package com.example.BancoCoreSoap.service;

import org.springframework.stereotype.Service;
import org.springframework.security.crypto.password.PasswordEncoder;
import com.example.BancoCoreSoap.service.NotificationService;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Optional;

import org.springframework.beans.factory.annotation.Autowired;
import com.example.BancoCoreSoap.repository.ClienteRepository;
import com.example.BancoCoreSoap.repository.ContaRepository;
import com.example.BancoCoreSoap.repository.TransacaoRepository;

import org.springframework.transaction.annotation.Transactional;
import com.example.demo.banco.gen.CriarContaResponse;
import com.example.demo.banco.gen.RealizarTransferenciaTEDRequest;
import com.example.demo.banco.gen.RealizarTransferenciaTEDResponse;
import com.example.demo.banco.gen.CriarContaRequest;
import com.example.BancoCoreSoap.domain.Cliente;
import com.example.BancoCoreSoap.domain.Conta;
import com.example.BancoCoreSoap.domain.TipoTransacao;
import com.example.BancoCoreSoap.domain.Transacao;

@Service
public class ContaService {
	
	@Autowired
	private ClienteRepository clienteRepository;
	
	@Autowired
	private ContaRepository contaRepository;
	
	@Autowired
	private TransacaoRepository transacaoRepository;

	@Autowired
    private NotificationService notificationService;

	@Autowired
	private PasswordEncoder passwordEncoder;
	
	@Transactional
	public CriarContaResponse create(CriarContaRequest request) {
		 Cliente clienteDono = clienteRepository.findById(request.getClienteId())
				 .orElseThrow(() -> new RuntimeException("Cliente não encontrado!"));
		 
		 Conta newConta = new Conta();
		 newConta.setNumeroConta(request.getNumeroConta());
		 newConta.setSaldo(request.getSaldoInicial()); 
		 newConta.setCliente(clienteDono);
		 
		 Conta savedConta = contaRepository.save(newConta);
		 
		 CriarContaResponse response = new CriarContaResponse();
		 response.setNumeroConta(savedConta.getNumeroConta());
		 response.setSaldo(savedConta.getSaldo());
		 response.setNomeCliente(savedConta.getCliente().getNome());
		 
		 return response;
	}
	
	@Transactional
	public RealizarTransferenciaTEDResponse realizarTransferencia(RealizarTransferenciaTEDRequest request) {

		Conta contaOrigem = contaRepository.findByNumeroConta(request.getContaOrigem().trim())
		        .orElseThrow(() -> new RuntimeException("Conta de origem não encontrada"));

		Conta contaDestino = contaRepository.findByNumeroConta(request.getContaDestino().trim())
		        .orElseThrow(() -> new RuntimeException("Conta de destino não encontrada"));
		
		if (contaOrigem.getSaldo().compareTo(request.getValor()) < 0) {
			throw new RuntimeException("Saldo insuficiente");
		}
		
		if (contaOrigem.getNumeroConta() == contaDestino.getNumeroConta()) {
			throw new RuntimeException("Não pode realizar uma transferencia para a mesma conta");
		}
		
		BigDecimal novoSaldoOrigem = contaOrigem.getSaldo().subtract(request.getValor());
		contaOrigem.setSaldo(novoSaldoOrigem);
		
		BigDecimal novoSaldoDestino = contaDestino.getSaldo().add(request.getValor());
		contaDestino.setSaldo(novoSaldoDestino);
		
		LocalDateTime agoraBrasilia = LocalDateTime.now(ZoneId.of("America/Sao_Paulo"));
		
		Transacao debito = new Transacao();
		debito.setConta(contaOrigem);
		debito.setDataHora(agoraBrasilia);
		debito.setTipo(TipoTransacao.TED);
		debito.setValor(request.getValor().negate());
		
		Transacao credito = new Transacao();
		credito.setConta(contaDestino);
		credito.setDataHora(agoraBrasilia);
		credito.setTipo(TipoTransacao.TED);
		credito.setValor(request.getValor());
		
		Transacao savedDebito = transacaoRepository.save(debito);
		Transacao savedCredito = transacaoRepository.save(credito);

		String clienteIdDestino = contaDestino.getNumeroConta();
        notificationService.publishTransferenceNotification(
            clienteIdDestino,
            request.getValor(),
            "TED"
        );
		
		RealizarTransferenciaTEDResponse response = new RealizarTransferenciaTEDResponse();
		response.setStatus("SUCESSO");
		response.setMensagem("Transferencia TED realizada com sucesso.");
		response.setNovoSaldoDestino(novoSaldoDestino);
		response.setNovoSaldoOrigem(novoSaldoOrigem);
		response.setTransacaoCreditoId(savedCredito.getId());
		response.setTransacaoDebitoId(savedDebito.getId());
		
		return response;
	}
	
	@Transactional
    public String autenticarUsuario(String numeroConta, String senhaRecebida) {
        
        Optional<Conta> contaOpt = contaRepository.findByNumeroConta(numeroConta);

        if (contaOpt.isPresent()) {
            Conta conta = contaOpt.get(); 

            if (conta.getCliente() != null && conta.getCliente().getUsuario() != null) {
                String senhaBanco = conta.getCliente().getUsuario().getPasswordHash();

                // A senha e gravada com BCrypt (Usuario.setPasswordHash), entao compara via encoder
                if (senhaRecebida != null && passwordEncoder.matches(senhaRecebida, senhaBanco)) {
                    return conta.getCliente().getNome();
                }
            }
        }
        
        return null;
    }
}
      